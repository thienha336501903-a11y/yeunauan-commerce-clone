#!/usr/bin/env node
// scripts/run-consolidated-pre-m0c-gate.js
// Authoritative Consolidated Pre-M0C Integration Gate Runner
// SYSTEM_B_CORE_PRE_M0C_CLOSURE_V4 — Phase 10

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

// One explicit isolated integration target. No fallback credentials or localhost
// defaults are accepted by the consolidated gate.
const REQUIRED_PRE_M0C_ENV = [
  "PRE_M0C_TEST_DATABASE_URL",
  "PRE_M0C_TEST_SUPABASE_URL",
  "PRE_M0C_TEST_SUPABASE_ANON_KEY",
  "PRE_M0C_TEST_SUPABASE_SERVICE_ROLE_KEY"
];

function normalizeExplicitTestEnvironment() {
  const missing = REQUIRED_PRE_M0C_ENV.filter((key) => !String(process.env[key] || "").trim());
  if (missing.length) {
    throw new Error(`Missing mandatory isolated integration environment: ${missing.join(", ")}`);
  }

  const dbUrl = String(process.env.PRE_M0C_TEST_DATABASE_URL).trim();
  const supabaseUrl = String(process.env.PRE_M0C_TEST_SUPABASE_URL).trim().replace(/\/$/, "");
  const forbidden = ["yyiavtiwtekkocqpephr", "aqozjkfwzmyfunqvcyjv"];
  if (forbidden.some((projectRef) => dbUrl.includes(projectRef) || supabaseUrl.includes(projectRef))) {
    throw new Error("Protected Main/Legacy Supabase targets are forbidden for destructive synthetic integration tests.");
  }

  let parsed;
  try {
    parsed = new URL(supabaseUrl);
  } catch {
    throw new Error("PRE_M0C_TEST_SUPABASE_URL is invalid.");
  }

  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!localHosts.has(parsed.hostname)) {
    throw new Error("PRE_M0C_TEST_SUPABASE_URL must point to an isolated local test stack.");
  }
  if (!/(127\.0\.0\.1|localhost|\[::1\])/.test(dbUrl)) {
    throw new Error("PRE_M0C_TEST_DATABASE_URL must point to the same isolated local test stack.");
  }

  const fingerprint = crypto
    .createHash("sha256")
    .update(`${supabaseUrl}\n${dbUrl}`)
    .digest("hex");

  process.env.DATABASE_URL = dbUrl;
  process.env.LOCAL_TEST_DB_URL = dbUrl;
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_ANON_KEY = process.env.PRE_M0C_TEST_SUPABASE_ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.PRE_M0C_TEST_SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.PRE_M0C_TEST_SUPABASE_ANON_KEY;
  process.env.REQUIRE_INTEGRATION_TESTS = "true";
  process.env.PRE_M0C_TEST_ENVIRONMENT_FINGERPRINT = fingerprint;

  return { dbUrl, supabaseUrl, fingerprint };
}

const TEST_TARGET = normalizeExplicitTestEnvironment();

const MANDATORY_ENV_VARS = [
  ...REQUIRED_PRE_M0C_ENV,
  "DATABASE_URL",
  "LOCAL_TEST_DB_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "PRE_M0C_TEST_ENVIRONMENT_FINGERPRINT",
  "V5_PLAYBACK_PRIVATE_JWK",
  "V5_MEDIA_PUBLIC_URL"
];

let localGatewayServer = null;

async function ensureLocalGateway() {
  if (process.env.SUPABASE_URL !== "http://127.0.0.1:54321" && !process.env.SUPABASE_URL.includes("54321")) {
    return;
  }

  // Check if port 54321 is already responsive
  try {
    const res = await fetch("http://127.0.0.1:54321/rest/v1/", {
      headers: { apikey: process.env.SUPABASE_ANON_KEY }
    });
    if (res.status === 200 || res.status === 404 || res.status === 401) {
      console.log("  ✓ Local Supabase gateway on port 54321 is already running.");
      return;
    }
  } catch (_) {
    // Not running, we will start it
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let targetPort = 54330;
      if (req.url.startsWith("/auth/v1")) {
        targetPort = 54331;
      }

      const proxyReq = http.request({
        hostname: "127.0.0.1",
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: req.headers
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on("error", (err) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Local Gateway Proxy Error: ${err.message}` }));
      });

      req.pipe(proxyReq);
    });

    server.listen(54321, "127.0.0.1", () => {
      console.log("  ✓ Local Supabase test gateway started on 127.0.0.1:54321 (rest:54330, auth:54331)");
      localGatewayServer = server;
      resolve();
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log("  ✓ Port 54321 in use, assuming external gateway active.");
        resolve();
      } else {
        reject(err);
      }
    });
  });
}

function checkEnvironment() {
  console.log("================================================================================");
  console.log("       CONSOLIDATED PRE-M0C INTEGRATION GATE — ISOLATED TARGET ONLY");
  console.log("================================================================================");
  console.log(`Execution Timestamp: ${new Date().toISOString()}`);

  const missing = MANDATORY_ENV_VARS.filter((key) => !String(process.env[key] || "").trim());
  if (missing.length) {
    throw new Error(`Mandatory integration environment missing after normalization: ${missing.join(", ")}`);
  }

  if (process.env.DATABASE_URL !== process.env.PRE_M0C_TEST_DATABASE_URL ||
      process.env.LOCAL_TEST_DB_URL !== process.env.PRE_M0C_TEST_DATABASE_URL) {
    throw new Error("DATABASE_URL/LOCAL_TEST_DB_URL target drift detected.");
  }
  if (process.env.SUPABASE_URL !== process.env.PRE_M0C_TEST_SUPABASE_URL.replace(/\/$/, "") ||
      process.env.SUPABASE_ANON_KEY !== process.env.PRE_M0C_TEST_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY !== process.env.PRE_M0C_TEST_SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Child Supabase environment is not normalized to the explicit test stack.");
  }

  console.log("  ✓ Explicit isolated PostgreSQL target configured");
  console.log("  ✓ Explicit isolated PostgREST/Auth target configured");
  console.log("  ✓ Main and Legacy project refs rejected");
}

async function verifyDatabaseConnectivity() {
  console.log("\n[2/8] Verifying Direct PostgreSQL Database Connectivity...");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const res = await client.query("SELECT current_database(), current_user, version();");
    console.log(`  ✓ Connected to DB: ${res.rows[0].current_database} (User: ${res.rows[0].current_user})`);
    await client.end();
  } catch (err) {
    console.error(`[FATAL] Direct DB connection failed: ${err.message}`);
    process.exit(1);
  }
}

async function verifySentinelRoundTrip() {
  console.log("\n[3/8] Verifying Sentinel Round-Trip Between PostgreSQL and PostgREST...");
  const nonce = Date.now().toString().slice(-6);
  const sentinelSlug = `sentinel-probe-${nonce}`;
  const sentinelName = `Sentinel Probe ${nonce}`;

  const pgClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await pgClient.connect();
  let sentinelId = null;
  try {
    // 1. Insert via direct PG
    const res = await pgClient.query(
      "INSERT INTO public.agencies (slug, name, status) VALUES ($1, $2, 'active') RETURNING id;",
      [sentinelSlug, sentinelName]
    );
    sentinelId = res.rows[0].id;

    // 2. Read back via PostgREST /rest/v1
    const postgrestUrl = `${process.env.SUPABASE_URL}/rest/v1/agencies?id=eq.${sentinelId}&select=id,slug,name`;
    const resp = await fetch(postgrestUrl, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!resp.ok) {
      throw new Error(`PostgREST sentinel query failed: HTTP ${resp.status} ${await resp.text()}`);
    }
    const rows = await resp.json();
    if (!rows || rows.length !== 1 || rows[0].slug !== sentinelSlug) {
      throw new Error(`PostgREST sentinel readback mismatch: expected slug ${sentinelSlug}, got ${JSON.stringify(rows)}`);
    }

    // 3. Delete via direct PG
    await pgClient.query("DELETE FROM public.agencies WHERE id = $1;", [sentinelId]);

    // 4. Verify PostgREST reflects deletion
    const resp2 = await fetch(postgrestUrl, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    const rows2 = await resp2.json();
    if (rows2 && rows2.length > 0) {
      throw new Error("PostgREST did not immediately reflect deletion of sentinel agency");
    }

    console.log("  ✓ Sentinel PG -> PostgREST readback and deletion verified.");
  } finally {
    if (sentinelId) {
      try { await pgClient.query("DELETE FROM public.agencies WHERE id = $1;", [sentinelId]); } catch (_) {}
    }
    await pgClient.end();
  }
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

function runSubProcess(label, command, args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`Running Suite: ${label}`);
    console.log(`Command: ${command} ${args.join(" ")} (Timeout: ${timeoutMs}ms)`);
    console.log(`--------------------------------------------------------------------------------`);

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        DATABASE_URL: process.env.PRE_M0C_TEST_DATABASE_URL,
        LOCAL_TEST_DB_URL: process.env.PRE_M0C_TEST_DATABASE_URL,
        SUPABASE_URL: process.env.PRE_M0C_TEST_SUPABASE_URL.replace(/\/$/, ""),
        SUPABASE_ANON_KEY: process.env.PRE_M0C_TEST_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.PRE_M0C_TEST_SUPABASE_SERVICE_ROLE_KEY,
        NEXT_PUBLIC_SUPABASE_URL: process.env.PRE_M0C_TEST_SUPABASE_URL.replace(/\/$/, ""),
        NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.PRE_M0C_TEST_SUPABASE_ANON_KEY,
        PRE_M0C_TEST_ENVIRONMENT_FINGERPRINT: TEST_TARGET.fingerprint,
        REQUIRE_INTEGRATION_TESTS: "true"
      }
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });

    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };

    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(new Error(`Suite '${label}' timed out after ${timeoutMs}ms; process tree terminated.`));
    }, timeoutMs);

    child.on("close", (code) => {
      const mandatorySkip = /(^|\n).*?(#\s*SKIP\b|SKIP_ENVIRONMENT\b|NOT_EXECUTED\b)/i.test(output);
      if (mandatorySkip) {
        return finish(new Error(`Suite '${label}' reported a mandatory skip/not-executed result.`));
      }
      if (code !== 0) {
        return finish(new Error(`Suite '${label}' exited with non-zero code ${code}`));
      }
      console.log(`\n  ✓ [PASS] Suite '${label}' succeeded without mandatory skips`);
      finish();
    });

    child.on("error", (err) => {
      killProcessTree(child);
      finish(err);
    });
  });
}

async function verifyB7PostgrestWriteDenials() {
  console.log("\n--------------------------------------------------------------------------------");
  console.log("Running Suite: B7 PostgREST Direct Write Lockdown (Direct Table Mutation Denials)");
  console.log("--------------------------------------------------------------------------------");

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const adminClient = createClient(url, serviceKey);
  const anonClient = createClient(url, anonKey);

  // 1. Create a transient test auth user to test authenticated role
  const testEmail = `b7-gate-${Date.now()}@example.local`;
  const testPassword = `B7P@ssword_${Date.now()}!`;
  const { data: userCreated, error: createErr } = await adminClient.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true
  });
  if (createErr) throw new Error(`Failed to create test user for B7 gate: ${createErr.message}`);
  const testUserId = userCreated.user.id;

  try {
    const { data: signinData, error: signinErr } = await anonClient.auth.signInWithPassword({
      email: testEmail,
      password: testPassword
    });
    if (signinErr) throw new Error(`Failed to sign in test user: ${signinErr.message}`);
    const authJwt = signinData.session.access_token;

    const dummyUuid = "00000000-0000-0000-0000-000000000000";

    // Probes for Anon
    console.log("  Testing 'anon' role PostgREST direct write denials on agency_homework_submissions...");
    const anonHeaders = {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json"
    };

    const anonInsert = await fetch(`${url}/rest/v1/agency_homework_submissions`, {
      method: "POST",
      headers: anonHeaders,
      body: JSON.stringify({ submission_title: "Hacked" })
    });
    const anonInsertBody = await anonInsert.text();
    if (anonInsert.status !== 401 || !anonInsertBody.includes("permission denied")) {
      throw new Error(`Anon direct INSERT was not denied with 401 permission denied (got ${anonInsert.status}: ${anonInsertBody})`);
    }
    console.log("    ✓ Anon INSERT denied: HTTP 401 / 42501 permission denied");

    const anonUpdate = await fetch(`${url}/rest/v1/agency_homework_submissions?id=eq.${dummyUuid}`, {
      method: "PATCH",
      headers: anonHeaders,
      body: JSON.stringify({ submission_title: "Hacked" })
    });
    const anonUpdateBody = await anonUpdate.text();
    if (anonUpdate.status !== 401 || !anonUpdateBody.includes("permission denied")) {
      throw new Error(`Anon direct UPDATE was not denied with 401 permission denied (got ${anonUpdate.status}: ${anonUpdateBody})`);
    }
    console.log("    ✓ Anon UPDATE denied: HTTP 401 / 42501 permission denied");

    const anonDelete = await fetch(`${url}/rest/v1/agency_homework_submissions?id=eq.${dummyUuid}`, {
      method: "DELETE",
      headers: anonHeaders
    });
    const anonDeleteBody = await anonDelete.text();
    if (anonDelete.status !== 401) {
      throw new Error(`Anon direct DELETE was not denied with 401 (got ${anonDelete.status}: ${anonDeleteBody})`);
    }
    console.log("    ✓ Anon DELETE denied: HTTP 401 permission denied");

    // Probes for Authenticated
    console.log("  Testing 'authenticated' role PostgREST direct write denials on agency_homework_submissions...");
    const authHeaders = {
      apikey: anonKey,
      Authorization: `Bearer ${authJwt}`,
      "Content-Type": "application/json"
    };

    const authInsert = await fetch(`${url}/rest/v1/agency_homework_submissions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ submission_title: "Hacked" })
    });
    const authInsertBody = await authInsert.text();
    if (authInsert.status !== 403 || !authInsertBody.includes("permission denied")) {
      throw new Error(`Authenticated direct INSERT was not denied with 403 permission denied (got ${authInsert.status}: ${authInsertBody})`);
    }
    console.log("    ✓ Authenticated INSERT denied: HTTP 403 / 42501 permission denied");

    const authUpdate = await fetch(`${url}/rest/v1/agency_homework_submissions?id=eq.${dummyUuid}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ submission_title: "Hacked" })
    });
    const authUpdateBody = await authUpdate.text();
    if (authUpdate.status !== 403 || !authUpdateBody.includes("permission denied")) {
      throw new Error(`Authenticated direct UPDATE was not denied with 403 permission denied (got ${authUpdate.status}: ${authUpdateBody})`);
    }
    console.log("    ✓ Authenticated UPDATE denied: HTTP 403 / 42501 permission denied");

    const authDelete = await fetch(`${url}/rest/v1/agency_homework_submissions?id=eq.${dummyUuid}`, {
      method: "DELETE",
      headers: authHeaders
    });
    const authDeleteBody = await authDelete.text();
    if (authDelete.status !== 403 || !authDeleteBody.includes("permission denied")) {
      throw new Error(`Authenticated direct DELETE was not denied with 403 permission denied (got ${authDelete.status}: ${authDeleteBody})`);
    }
    console.log("    ✓ Authenticated DELETE denied: HTTP 403 / 42501 permission denied");

    console.log("  ✓ [PASS] B7 PostgREST write denials verified: direct table mutations strictly prohibited for anon and authenticated.");
  } finally {
    if (testUserId) {
      try {
        await adminClient.auth.admin.deleteUser(testUserId);
      } catch (_) {}
    }
  }
}

async function main() {
  try {
    checkEnvironment();
    await ensureLocalGateway();
    await verifyDatabaseConnectivity();
    await verifySentinelRoundTrip();

    // 1. Suite: B5 Real DB Concurrency & Kernel Lock Contention
    await runSubProcess(
      "B5 Real Database Advisory Lock Contention",
      "node",
      ["test/multi-agency-b5-real-db.test.js"]
    );

    // 2. Suite: Privileged RPC Dynamic Discovery & Complete Lockdown
    await runSubProcess(
      "Privileged RPC Catalog Discovery & Lockdown",
      "node",
      ["scripts/test-m0b1-phase-a-containment.js"]
    );

    // 3. Suite: Synthetic Agency Provisioning Lifecycle & Safety
    await runSubProcess(
      "Synthetic Agency Provisioning Lifecycle & Cleanup",
      "node",
      ["test/synthetic-agency-provisioning.test.js"]
    );

    // 4. Suite: Second Tenant Real Two-Way Request Isolation
    await runSubProcess(
      "Second Tenant Real Two-Way Request Isolation",
      "node",
      ["test/second-tenant-isolation.test.js"]
    );

    // 5. Suite: Pre-M0C Functional Acceptance Harness
    await runSubProcess(
      "Pre-M0C Functional Acceptance Harness (10 Categories)",
      "node",
      ["scripts/verify-pre-m0c-acceptance.js"]
    );

    // 6. Suite: B7 Direct PostgREST Write Denials
    await verifyB7PostgrestWriteDenials();

    console.log("\n================================================================================");
    console.log("       SYSTEM B — ALL PRE-M0C INTEGRATION SUITES EXECUTED SUCCESSFULLY");
    console.log("================================================================================");
    console.log("SUMMARY OF EVALUATION:");
    console.log("  - B5 Real Lock Contention: PASS (pg_blocking_pids asserts Transaction 1 contention)");
    console.log("  - Privileged RPC Lockdown: PASS (22 server-only signatures revoked & PostgREST denied)");
    console.log("  - M0C Provisioning Preflight: PASS (Auth principals & V5 releases verified before writes)");
    console.log("  - M0C Atomic Apply: PASS (provision_agency_manifest_atomic with advisory lock)");
    console.log("  - Synthetic Cleanup Safety: PASS (deprovision_synthetic_agency_atomic via fixture registry)");
    console.log("  - Synthetic Agency Rehearsal: PASS (Full request lifecycle verified)");
    console.log("  - Second Tenant Isolation: PASS (2-way playback, orders, homework strictly isolated)");
    console.log("  - Pre-M0C Acceptance: PASS (10/10 mandatory categories verified)");
    console.log("  - B7 PostgREST Write Denials: PASS (INSERT/UPDATE/DELETE denied for anon and authenticated)");
    console.log("================================================================================");
    console.log("CONSOLIDATED_TEST_QUALITY = PASS");
    console.log("================================================================================");

    if (localGatewayServer) {
      localGatewayServer.close();
    }
    process.exit(0);
  } catch (err) {
    if (localGatewayServer) {
      localGatewayServer.close();
    }
    console.error(`\n[FATAL] Consolidated integration gate failure: ${err.message}`);
    console.log("CONSOLIDATED_TEST_QUALITY = FAIL");
    process.exit(1);
  }
}

main();
