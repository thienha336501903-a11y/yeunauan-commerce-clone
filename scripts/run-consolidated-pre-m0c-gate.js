#!/usr/bin/env node
// scripts/run-consolidated-pre-m0c-gate.js
// Authoritative Consolidated Pre-M0C Integration Gate Runner
// SYSTEM_B_CORE_PRE_M0C_CLOSURE_V4 — Phase 10

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

// Ensure DATABASE_URL is set for DB tests if not already present
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:54332/postgres";
}

const MANDATORY_ENV_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "DATABASE_URL"
];

function checkEnvironment() {
  console.log("================================================================================");
  console.log("       PHASE 10: CONSOLIDATED PRE-M0C INTEGRATION GATE EXECUTION");
  console.log("================================================================================");
  console.log(`Execution Timestamp: ${new Date().toISOString()}`);
  console.log("");
  console.log("[1/7] Validating Mandatory Environment Configurations...");

  const missing = [];
  for (const envKey of MANDATORY_ENV_VARS) {
    const val = process.env[envKey] || (envKey.startsWith("SUPABASE") ? process.env[`NEXT_PUBLIC_${envKey}`] : null);
    if (!val) {
      missing.push(envKey);
    }
  }

  if (missing.length > 0) {
    console.error(`[FATAL] Missing mandatory environment variable(s): ${missing.join(", ")}`);
    console.error("Consolidated gate fails closed when mandatory environment credentials are missing.");
    process.exit(1);
  }

  console.log("  ✓ SUPABASE_URL: Configured");
  console.log("  ✓ SUPABASE_SERVICE_ROLE_KEY: Configured");
  console.log("  ✓ SUPABASE_ANON_KEY: Configured");
  console.log("  ✓ DATABASE_URL: Configured");
}

async function verifyDatabaseConnectivity() {
  console.log("\n[2/7] Verifying Direct PostgreSQL Database Connectivity...");
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

function runSubProcess(label, command, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`Running Suite: ${label}`);
    console.log(`Command: ${command} ${args.join(" ")}`);
    console.log(`--------------------------------------------------------------------------------`);

    const child = spawn(command, args, {
      stdio: "inherit",
      shell: true,
      env: process.env
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log(`\n  ✓ [PASS] Suite '${label}' succeeded (exit code 0)`);
        resolve();
      } else {
        console.error(`\n  ✗ [FAIL] Suite '${label}' failed with exit code ${code}`);
        reject(new Error(`Suite '${label}' exited with non-zero code ${code}`));
      }
    });

    child.on("error", (err) => {
      console.error(`\n  ✗ [ERROR] Suite '${label}' process error: ${err.message}`);
      reject(err);
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
    await verifyDatabaseConnectivity();

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
    console.log("  - Privileged RPC Lockdown: PASS (10 server-only signatures revoked & PostgREST denied)");
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

    process.exit(0);
  } catch (err) {
    console.error(`\n[FATAL] Consolidated integration gate failure: ${err.message}`);
    console.log("CONSOLIDATED_TEST_QUALITY = FAIL");
    process.exit(1);
  }
}

main();
