// test/helpers/pre-m0c-test-target.js
// Test-only isolated target guard for destructive synthetic provisioning suites.
// This module is never imported by production application code.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const FORBIDDEN_PROJECT_REFS = new Set([
  "yyiavtiwtekkocqpephr",
  "aqozjkfwzmyfunqvcyjv"
]);
const FORBIDDEN_SYSTEM_IDENTIFIERS = new Set([
  "7666007964130682852", // Main
  "7642734024280108049"  // Legacy
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function normalizeSupabaseUrl(raw) {
  return String(raw || "").trim().replace(/\/$/, "");
}

function parseUrl(raw, label) {
  try {
    return new URL(String(raw || "").trim());
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}

function assertLoopbackHostname(parsed, label) {
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${label} must point to an explicit loopback hostname, not '${parsed.hostname}'.`);
  }
}

function assertNoProtectedProjectRef(...values) {
  for (const value of values) {
    const text = String(value || "");
    for (const projectRef of FORBIDDEN_PROJECT_REFS) {
      if (text.includes(projectRef)) {
        throw new Error(`Protected Main/Legacy target ${projectRef} cannot be used for pre-M0C synthetic integration tests.`);
      }
    }
  }
}

function resolveIdentityFilePath() {
  const raw = String(process.env.PRE_M0C_TEST_DB_IDENTITY_FILE || "").trim();
  if (!raw) {
    throw new Error("SKIP_ENVIRONMENT: PRE_M0C_TEST_DB_IDENTITY_FILE is required and must point to a pinned isolated-test identity file created before this gate.");
  }
  const resolved = path.resolve(raw);
  const cwd = path.resolve(process.cwd());
  const relative = path.relative(cwd, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("PRE_M0C_TEST_DB_IDENTITY_FILE must live outside the repository working tree.");
  }
  return resolved;
}

export function validateExplicitLoopbackTargetUrls() {
  const dbUrl = String(process.env.PRE_M0C_TEST_DATABASE_URL || "").trim();
  const supabaseUrl = normalizeSupabaseUrl(process.env.PRE_M0C_TEST_SUPABASE_URL);

  if (!dbUrl || !supabaseUrl) {
    throw new Error("SKIP_ENVIRONMENT: explicit PRE_M0C_TEST_DATABASE_URL and PRE_M0C_TEST_SUPABASE_URL are required.");
  }

  assertNoProtectedProjectRef(dbUrl, supabaseUrl);

  const parsedDb = parseUrl(dbUrl, "PRE_M0C_TEST_DATABASE_URL");
  if (!["postgres:", "postgresql:"].includes(parsedDb.protocol)) {
    throw new Error("PRE_M0C_TEST_DATABASE_URL must use postgres:// or postgresql://.");
  }
  assertLoopbackHostname(parsedDb, "PRE_M0C_TEST_DATABASE_URL");

  const parsedSupabase = parseUrl(supabaseUrl, "PRE_M0C_TEST_SUPABASE_URL");
  if (!["http:", "https:"].includes(parsedSupabase.protocol)) {
    throw new Error("PRE_M0C_TEST_SUPABASE_URL must use http:// or https://.");
  }
  assertLoopbackHostname(parsedSupabase, "PRE_M0C_TEST_SUPABASE_URL");

  return { dbUrl, supabaseUrl };
}

export function loadPinnedPreM0cIdentity() {
  const identityFile = resolveIdentityFilePath();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(identityFile, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read pinned pre-M0C identity file '${identityFile}': ${error.message}`);
  }

  const systemIdentifier = String(parsed?.systemIdentifier || "").trim();
  const databaseName = String(parsed?.databaseName || "").trim();
  const supabaseUrl = normalizeSupabaseUrl(parsed?.supabaseUrl);

  if (parsed?.version !== 1 || !/^\d+$/.test(systemIdentifier) || !databaseName || !supabaseUrl) {
    throw new Error("Pinned pre-M0C identity file is invalid; expected version=1, numeric systemIdentifier, databaseName and supabaseUrl.");
  }

  const parsedSupabase = parseUrl(supabaseUrl, "Pinned supabaseUrl");
  assertLoopbackHostname(parsedSupabase, "Pinned supabaseUrl");
  assertNoProtectedProjectRef(supabaseUrl);

  return Object.freeze({
    identityFile,
    systemIdentifier,
    databaseName,
    supabaseUrl
  });
}

export function derivePreM0cEnvironmentFingerprint(identity) {
  return crypto
    .createHash("sha256")
    .update(`${identity.systemIdentifier}\n${identity.databaseName}\n${identity.supabaseUrl}`)
    .digest("hex");
}

export async function verifyPreM0cTestTargetIdentity({ requireGuardAbsent = true } = {}) {
  const { dbUrl, supabaseUrl } = validateExplicitLoopbackTargetUrls();
  const pinned = loadPinnedPreM0cIdentity();

  if (supabaseUrl !== pinned.supabaseUrl) {
    throw new Error("PRE_M0C_TEST_SUPABASE_URL does not match the independently pinned isolated-test identity.");
  }

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '5000ms'");
    const identityRes = await client.query(`
      SELECT
        (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
        current_database() AS database_name,
        to_regclass('public.__pre_m0c_test_target_guard')::text AS guard_table
    `);
    const row = identityRes.rows[0];

    if (FORBIDDEN_SYSTEM_IDENTIFIERS.has(String(row.system_identifier))) {
      throw new Error("Protected Main/Legacy PostgreSQL cluster identity cannot be used for pre-M0C synthetic tests, even through loopback/tunnel aliases.");
    }
    if (String(row.system_identifier) !== pinned.systemIdentifier) {
      throw new Error(
        `Trusted test-target identity mismatch: connected PostgreSQL system_identifier '${row.system_identifier}' does not match pinned isolated-test identifier '${pinned.systemIdentifier}'.`
      );
    }
    if (String(row.database_name) !== pinned.databaseName) {
      throw new Error(
        `Trusted test-target database mismatch: connected database '${row.database_name}' does not match pinned '${pinned.databaseName}'.`
      );
    }
    if (requireGuardAbsent && row.guard_table) {
      throw new Error("Trusted test-target guard already exists before identity verification; refusing to proceed.");
    }

    const identity = Object.freeze({
      ...pinned,
      dbUrl,
      supabaseUrl,
      environmentFingerprint: derivePreM0cEnvironmentFingerprint(pinned)
    });
    return identity;
  } finally {
    await client.end();
  }
}

function establishVerifiedContext(identity) {
  process.env.PRE_M0C_TEST_VERIFIED_SYSTEM_IDENTIFIER = identity.systemIdentifier;
  process.env.PRE_M0C_TEST_ENVIRONMENT_FINGERPRINT = identity.environmentFingerprint;
  process.env.PRE_M0C_TEST_TARGET_VERIFIED = "true";
}

export async function installPreM0cTestTargetGuard(runId) {
  if (!runId) throw new Error("runId is required to install the isolated test-target guard.");
  if (process.env.PRE_M0C_TEST_SAME_STACK_VERIFIED !== "true") {
    throw new Error(
      "SECURITY VIOLATION: Test-target guard creation requires the consolidated runner to verify the pinned DB identity and PG/PostgREST sentinel round-trip first."
    );
  }

  // Identity is established read-only before guard creation. A loopback URL by
  // itself is never sufficient authority because it may be a tunnel.
  const identity = await verifyPreM0cTestTargetIdentity({ requireGuardAbsent: true });
  establishVerifiedContext(identity);

  const client = new pg.Client({ connectionString: identity.dbUrl });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '5000ms'");
    await client.query(`
      CREATE TABLE public.__pre_m0c_test_target_guard (
        run_id uuid PRIMARY KEY,
        environment_fingerprint text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      REVOKE ALL ON TABLE public.__pre_m0c_test_target_guard FROM PUBLIC, anon, authenticated, service_role;
    `);
    await client.query(
      `INSERT INTO public.__pre_m0c_test_target_guard (run_id, environment_fingerprint)
       VALUES ($1, $2)`,
      [runId, identity.environmentFingerprint]
    );
  } finally {
    await client.end();
  }

  return {
    runId,
    systemIdentifier: identity.systemIdentifier,
    environmentFingerprint: identity.environmentFingerprint
  };
}

export async function removePreM0cTestTargetGuard(runId) {
  const identity = await verifyPreM0cTestTargetIdentity({ requireGuardAbsent: false });
  establishVerifiedContext(identity);

  const client = new pg.Client({ connectionString: identity.dbUrl });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '5000ms'");
    const guardTable = await client.query(
      "SELECT to_regclass('public.__pre_m0c_test_target_guard')::text AS guard_table"
    );
    if (!guardTable.rows[0]?.guard_table) return;

    await client.query(
      "DELETE FROM public.__pre_m0c_test_target_guard WHERE run_id = $1 AND environment_fingerprint = $2",
      [runId, identity.environmentFingerprint]
    );

    const remaining = await client.query(
      "SELECT count(*)::int AS count FROM public.__pre_m0c_test_target_guard"
    );
    if (remaining.rows[0].count === 0) {
      await client.query("DROP TABLE public.__pre_m0c_test_target_guard");
    }
  } finally {
    await client.end();
  }
}
