#!/usr/bin/env node
// One-time bootstrap for a freshly created isolated local restore.
// Run this separately when the restore is created, BEFORE the consolidated gate.
// The resulting identity file must live outside the repository.

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { validateExplicitLoopbackTargetUrls } from "../test/helpers/pre-m0c-test-target.js";

const FORBIDDEN_SYSTEM_IDENTIFIERS = new Set([
  "7666007964130682852", // Main
  "7642734024280108049"  // Legacy
]);

async function main() {
  const { dbUrl, supabaseUrl } = validateExplicitLoopbackTargetUrls();
  const identityFileRaw = String(process.env.PRE_M0C_TEST_DB_IDENTITY_FILE || "").trim();
  if (!identityFileRaw) throw new Error("PRE_M0C_TEST_DB_IDENTITY_FILE is required.");

  const identityFile = path.resolve(identityFileRaw);
  const cwd = path.resolve(process.cwd());
  const relative = path.relative(cwd, identityFile);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("PRE_M0C_TEST_DB_IDENTITY_FILE must live outside the repository working tree.");
  }

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '5000ms'");
    const result = await client.query(`
      SELECT
        (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
        current_database() AS database_name,
        to_regclass('public.__pre_m0c_test_target_guard')::text AS guard_table,
        (SELECT count(*)::int FROM public.agency_test_fixtures) AS fixture_count
    `);
    const row = result.rows[0];
    if (FORBIDDEN_SYSTEM_IDENTIFIERS.has(String(row.system_identifier))) {
      throw new Error("Refusing bootstrap: connected PostgreSQL cluster is protected Main/Legacy, even if reached through a loopback alias or tunnel.");
    }
    if (row.guard_table) throw new Error("Refusing bootstrap: test-target guard already exists.");
    if (row.fixture_count !== 0) throw new Error("Refusing bootstrap: synthetic fixture rows already exist.");

    fs.mkdirSync(path.dirname(identityFile), { recursive: true });
    fs.writeFileSync(
      identityFile,
      JSON.stringify({
        version: 1,
        systemIdentifier: String(row.system_identifier),
        databaseName: String(row.database_name),
        supabaseUrl,
        createdAt: new Date().toISOString()
      }, null, 2) + "\n",
      { mode: 0o600 }
    );
    console.log(`Pinned isolated pre-M0C database identity at ${identityFile}`);
    console.log(`system_identifier=${row.system_identifier}`);
    console.log(`database=${row.database_name}`);
    console.log(`supabase_url=${supabaseUrl}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[FATAL] ${error.message}`);
  process.exit(1);
});
