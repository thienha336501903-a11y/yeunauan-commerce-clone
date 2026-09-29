// scripts/test-m0b1-phase-a-containment.js
// Verification script for M0B.1 / Pre-M0C Remediation V3 Privileged RPC Discovery
// Dynamically verifies from pg_catalog that ALL public schema functions are explicitly
// classified and all privileged server-only RPC signatures are revoked from BOTH anon
// and authenticated PostgREST roles.

import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import crypto from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.LOCAL_TEST_DB_URL || "postgres://postgres:postgres@127.0.0.1:54332/postgres";

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_ANON_KEY");
  process.exit(1);
}

const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Authoritative Classification Map
// Category definitions:
// - SERVER_ONLY_RPC: Function callable via RPC by service_role only. anon and authenticated MUST be revoked.
// - PUBLIC_SAFE_RPC: Function intentionally exposed to public/authenticated (e.g. domain lookup, login).
// - INTERNAL_NOT_POSTGREST: Internal helpers not intended as external RPC endpoints.
// - INTERNAL_TRIGGER: Trigger-only functions (RETURNS trigger); never application RPCs.
const FUNCTION_CLASSIFICATIONS = {
  // B5 & B7 Multi-Agency Privileged RPCs
  "approve_agency_order(p_agency_id uuid, p_order_id uuid, p_approved_by_membership_id uuid)": "SERVER_ONLY_RPC",
  "checkout_agency_offering(p_agency_id uuid, p_membership_id uuid, p_offering_id uuid, p_bank_account_id uuid, p_idempotency_order_code text)": "SERVER_ONLY_RPC",
  "refund_agency_order(p_agency_id uuid, p_order_id uuid, p_reason text)": "SERVER_ONLY_RPC",
  "recompute_effective_entitlement(p_agency_id uuid, p_entitlement_id uuid)": "SERVER_ONLY_RPC",
  "grade_agency_homework(p_agency_id uuid, p_staff_membership_id uuid, p_submission_id uuid, p_status text, p_feedback text, p_score numeric)": "SERVER_ONLY_RPC",
  "submit_agency_homework(p_agency_id uuid, p_membership_id uuid, p_canonical_course_id uuid, p_canonical_lesson_id uuid, p_title text, p_content jsonb)": "SERVER_ONLY_RPC",
  "submit_agency_homework(p_agency_id uuid, p_membership_id uuid, p_canonical_course_id uuid, p_lesson_id text, p_title text, p_content jsonb)": "SERVER_ONLY_RPC",
  "set_trusted_agency_context(p_agency_id uuid)": "SERVER_ONLY_RPC",
  "deprovision_synthetic_agency_atomic(p_agency_id uuid, p_run_id uuid)": "SERVER_ONLY_RPC",
  "provision_agency_manifest_atomic(p_manifest jsonb, p_is_synthetic boolean, p_rehearsal_run_id uuid)": "SERVER_ONLY_RPC",
  // Multi-Agency Student Playback Bridge RPC (Accessible to authenticated students, revoked from anon)
  "v5_authorize_agency_playback(p_agency_id uuid, p_membership_id uuid, p_lesson_id uuid, p_asset_id uuid)": "AUTHENTICATED_PLAYBACK_RPC",

  // V5 Platform Maintenance & Cloner Operations (Revoked from PUBLIC, anon, and authenticated — strictly SERVER_ONLY_RPC)
  "begin_v5_course_retire_purge(p_course_id uuid, p_expected_slug text, p_plan_hash text, p_admin_email text, p_manifest jsonb, p_r2_object_count integer, p_r2_total_bytes bigint)": "SERVER_ONLY_RPC",
  "finalize_v5_course_retire_purge(p_operation_id uuid, p_course_id uuid, p_expected_slug text)": "SERVER_ONLY_RPC",
  "cleanup_v5_clone_factory_fixture(p_course_id uuid, p_expected_slug text)": "SERVER_ONLY_RPC",
  "cleanup_v5_unreleased_draft_course(p_course_id uuid, p_expected_slug text)": "SERVER_ONLY_RPC",
  "v5_publish_release_atomic(p_course_id uuid, p_snapshot jsonb, p_created_by text)": "SERVER_ONLY_RPC",
  "v5_replace_telegram_media_atomic(p_course_id uuid, p_post_id uuid, p_old_asset_id uuid, p_new_asset_id uuid)": "SERVER_ONLY_RPC",
  "claim_v5_telegram_mirror_job(p_agent_id text)": "SERVER_ONLY_RPC",
  "finish_v5_telegram_mirror_job(p_job_id uuid, p_agent_id text, p_ok boolean, p_object_key text, p_bytes bigint, p_etag text, p_error text, p_attempt integer)": "SERVER_ONLY_RPC",
  "tgcloner_apply_reconcile_snapshot(p_source_id uuid, p_telegram_chat_id text, p_upper_bound_message_id bigint, p_present_message_ids bigint[])": "SERVER_ONLY_RPC",
  "tgcloner_dispatch_tick()": "SERVER_ONLY_RPC",
  "reset_student_session_guard(p_email text, p_admin_email text, p_reason text)": "SERVER_ONLY_RPC",
  "cleanup_student_account_risk_events(p_retention_days integer)": "SERVER_ONLY_RPC",

  // Public / Safe RPCs
  "resolve_agency_domain(p_hostname text)": "PUBLIC_SAFE_RPC",
  "handle_student_session_login(p_email text, p_portal_device_id text, p_new_student_session_id text, p_device_hash text, p_device_label text, p_ip text, p_ip_hash text, p_user_agent text, p_conflict_policy text, p_idle_hours integer)": "PUBLIC_SAFE_RPC",

  // Internal Triggers & RLS Policy Functions (Not PostgREST endpoints)
  "current_agency_id()": "INTERNAL_NOT_POSTGREST",
  "trusted_auth_agency_ids()": "INTERNAL_NOT_POSTGREST",
  "trusted_auth_membership_ids()": "INTERNAL_NOT_POSTGREST",
  "enforce_v5_archived_config_lock()": "INTERNAL_NOT_POSTGREST",
  "enforce_v5_course_lifecycle()": "INTERNAL_NOT_POSTGREST",
  "enforce_v5_course_mode()": "INTERNAL_NOT_POSTGREST",
  "enforce_v5_media_integrity()": "INTERNAL_NOT_POSTGREST",
  "enforce_v5_release_immutability()": "INTERNAL_NOT_POSTGREST",
  "enforce_v5_retired_course_sale_lock()": "INTERNAL_NOT_POSTGREST",
  "rls_auto_enable()": "INTERNAL_NOT_POSTGREST",
  "sync_v5_course_failclosed_flags()": "INTERNAL_NOT_POSTGREST",
  "tgcloner_update_source_ingest_activity()": "INTERNAL_NOT_POSTGREST",
  "v5_authorize_playback_asset(p_course_id uuid, p_asset_id uuid)": "INTERNAL_NOT_POSTGREST",
  "v5_clone_factory_cleanup_allowed(p_course_id uuid)": "INTERNAL_NOT_POSTGREST",
  "v5_retire_purge_release_delete_allowed(p_course_id uuid)": "INTERNAL_NOT_POSTGREST",
  "validate_v5_retire_purge_r2_delete_safe(p_operation_id uuid)": "INTERNAL_NOT_POSTGREST",
  "trg_prevent_agency_test_fixture_mutation()": "INTERNAL_TRIGGER"
};

/**
 * Validates inventory from pg_catalog against classification map.
 * Throws if any function is unclassified.
 */
export function validateCatalogInventory(catalogFunctions) {
  const unclassified = [];
  const classified = {
    SERVER_ONLY_RPC: [],
    PUBLIC_SAFE_RPC: [],
    AUTHENTICATED_PLAYBACK_RPC: [],
    INTERNAL_NOT_POSTGREST: [],
    INTERNAL_TRIGGER: []
  };

  for (const fn of catalogFunctions) {
    const signature = `${fn.name}(${fn.identity_args})`;
    const category = FUNCTION_CLASSIFICATIONS[signature];
    if (!category) {
      unclassified.push(signature);
    } else {
      classified[category].push({ ...fn, signature });
    }
  }

  if (unclassified.length > 0) {
    throw new Error(`Inventory mismatch: Discovered unclassified function signatures in pg_catalog:\n${unclassified.join("\n")}`);
  }

  return classified;
}

async function main() {
  console.log("=== PRE-M0C PHASE 15 PRIVILEGED RPC DYNAMIC CATALOG DISCOVERY SUITE ===");
  console.log(`Supabase Target: ${SUPABASE_URL}`);
  console.log(`PostgreSQL Catalog: ${DB_URL.replace(/:[^:]*@/, ":***@")}\n`);

  // 1. Dynamic Catalog Discovery from pg_proc
  const pool = new pg.Pool({ connectionString: DB_URL });
  let catalogFunctions = [];
  try {
    const res = await pool.query(`
      SELECT 
        p.oid,
        p.proname as name,
        pg_get_function_identity_arguments(p.oid) as identity_args,
        p.prosecdef as secdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
      ORDER BY p.proname, identity_args;
    `);
    catalogFunctions = res.rows;
    console.log(`Discovered ${catalogFunctions.length} public functions in pg_catalog.`);
  } finally {
    await pool.end();
  }

  // 2. Validate Inventory & Classifications
  const classified = validateCatalogInventory(catalogFunctions);
  console.log(`Classified: ${classified.SERVER_ONLY_RPC.length} SERVER_ONLY_RPC, ${classified.PUBLIC_SAFE_RPC.length} PUBLIC_SAFE_RPC, ${classified.AUTHENTICATED_PLAYBACK_RPC.length} AUTHENTICATED_PLAYBACK_RPC, ${classified.INTERNAL_NOT_POSTGREST.length} INTERNAL_NOT_POSTGREST, ${classified.INTERNAL_TRIGGER.length} INTERNAL_TRIGGER.`);

  // 3. Synthetic Negative Test: Verify unclassified signature fails immediately
  console.log("\n--- Testing Synthetic Fixture Failure (Unclassified Signature Must Fail) ---");
  let syntheticFailedCorrectly = false;
  try {
    const syntheticCatalog = [
      ...catalogFunctions,
      { name: "synthetic_unclassified_rpc", identity_args: "p_data jsonb", secdef: true }
    ];
    validateCatalogInventory(syntheticCatalog);
  } catch (err) {
    if (err.message.includes("Inventory mismatch: Discovered unclassified function signatures")) {
      syntheticFailedCorrectly = true;
      console.log("[PASS] Synthetic fixture correctly triggered inventory mismatch failure.");
    }
  }
  if (!syntheticFailedCorrectly) {
    console.error("[FAIL] Synthetic unclassified signature was NOT caught!");
    process.exit(1);
  }

  // 4. Verify PostgreSQL Role Privileges for EVERY SERVER_ONLY_RPC signature
  console.log("\n--- Testing PostgreSQL Role Privilege on EVERY SERVER_ONLY_RPC Signature ---");
  const poolAcl = new pg.Pool({ connectionString: DB_URL });
  let aclAllRevoked = true;
  try {
    for (const fn of classified.SERVER_ONLY_RPC) {
      const aclRes = await poolAcl.query(
        `SELECT 
           has_function_privilege('anon', $1::oid, 'EXECUTE') as anon_exec,
           has_function_privilege('authenticated', $1::oid, 'EXECUTE') as auth_exec`,
        [fn.oid]
      );
      const { anon_exec, auth_exec } = aclRes.rows[0];
      if (anon_exec === true || auth_exec === true) {
        console.error(`[FAIL] Signature ${fn.signature} has execution granted! anon: ${anon_exec}, authenticated: ${auth_exec}`);
        aclAllRevoked = false;
      } else {
        console.log(`[PASS] SQL ACL revoked for: ${fn.signature}`);
      }
    }
  } finally {
    await poolAcl.end();
  }
  if (!aclAllRevoked) {
    console.error("FAIL: One or more server-only RPCs have unrevoked SQL privileges!");
    process.exit(1);
  }

  // 5. Test PostgREST Boundaries on SERVER_ONLY_RPC
  const testEmail = `phase-a-test-${Date.now()}@example.com`;
  const testPassword = `TestP@ss_${crypto.randomBytes(8).toString("hex")}`;
  let userId = null;

  // Dedicated unauthenticated anon client
  const unauthAnonClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { apikey: ANON_KEY } }
  });

  try {
    const { data: userCreated, error: createError } = await adminClient.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
      role: "authenticated"
    });
    if (createError) throw createError;
    userId = userCreated.user.id;

    // Use a separate auth helper client so unauthAnonClient is never mutated
    const authHelperClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: signinData, error: signinError } = await authHelperClient.auth.signInWithPassword({
      email: testEmail,
      password: testPassword
    });
    if (signinError) throw signinError;
    const userJwt = signinData.session.access_token;

    const authUserClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${userJwt}`, apikey: ANON_KEY } },
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const dummyUuid = "00000000-0000-0000-0000-000000000000";
    let allDenied = true;

    // PostgREST-callable server-only RPC targets (covering both TEXT and UUID overloads)
    const serverOnlyHttpTargets = [
      { name: "approve_agency_order", params: { p_agency_id: dummyUuid, p_order_id: dummyUuid, p_approved_by_membership_id: dummyUuid } },
      { name: "checkout_agency_offering", params: { p_agency_id: dummyUuid, p_membership_id: dummyUuid, p_offering_id: dummyUuid, p_bank_account_id: dummyUuid, p_idempotency_order_code: "TEST1234" } },
      { name: "refund_agency_order", params: { p_agency_id: dummyUuid, p_order_id: dummyUuid, p_reason: "Test refund" } },
      { name: "recompute_effective_entitlement", params: { p_agency_id: dummyUuid, p_entitlement_id: dummyUuid } },
      { name: "submit_agency_homework", params: { p_agency_id: dummyUuid, p_membership_id: dummyUuid, p_canonical_course_id: dummyUuid, p_canonical_lesson_id: dummyUuid, p_title: "Test HW UUID", p_content: {} } },
      { name: "submit_agency_homework", params: { p_agency_id: dummyUuid, p_membership_id: dummyUuid, p_canonical_course_id: dummyUuid, p_lesson_id: "lesson-test-text", p_title: "Test HW TEXT", p_content: {} } },
      { name: "grade_agency_homework", params: { p_agency_id: dummyUuid, p_staff_membership_id: dummyUuid, p_submission_id: dummyUuid, p_status: "evaluated", p_feedback: "Test", p_score: 10 } },
      { name: "set_trusted_agency_context", params: { p_agency_id: dummyUuid } },
      { name: "deprovision_synthetic_agency_atomic", params: { p_agency_id: dummyUuid, p_run_id: dummyUuid } },
      { name: "provision_agency_manifest_atomic", params: { p_manifest: {}, p_is_synthetic: false, p_rehearsal_run_id: dummyUuid } },
      { name: "begin_v5_course_retire_purge", params: { p_course_id: dummyUuid, p_expected_slug: "probe", p_plan_hash: "hash", p_admin_email: "a@b.c", p_manifest: {}, p_r2_object_count: 0, p_r2_total_bytes: 0 } },
      { name: "finalize_v5_course_retire_purge", params: { p_operation_id: dummyUuid, p_course_id: dummyUuid, p_expected_slug: "probe" } },
      { name: "cleanup_v5_clone_factory_fixture", params: { p_course_id: dummyUuid, p_expected_slug: "probe" } },
      { name: "cleanup_v5_unreleased_draft_course", params: { p_course_id: dummyUuid, p_expected_slug: "probe" } },
      { name: "v5_publish_release_atomic", params: { p_course_id: dummyUuid, p_snapshot: {}, p_created_by: "probe" } },
      { name: "v5_replace_telegram_media_atomic", params: { p_course_id: dummyUuid, p_post_id: dummyUuid, p_old_asset_id: dummyUuid, p_new_asset_id: dummyUuid } },
      { name: "claim_v5_telegram_mirror_job", params: { p_agent_id: "probe" } },
      { name: "finish_v5_telegram_mirror_job", params: { p_job_id: dummyUuid, p_agent_id: "probe", p_ok: true, p_object_key: "k", p_bytes: 0, p_etag: "e", p_error: null, p_attempt: 1 } },
      { name: "tgcloner_apply_reconcile_snapshot", params: { p_source_id: dummyUuid, p_telegram_chat_id: "probe", p_upper_bound_message_id: 1, p_present_message_ids: [] } },
      { name: "tgcloner_dispatch_tick", params: {} },
      { name: "reset_student_session_guard", params: { p_email: "probe@example.com", p_admin_email: "admin@example.com", p_reason: "probe" } },
      { name: "cleanup_student_account_risk_events", params: { p_retention_days: 30 } }
    ];

    console.log("\n--- Testing ANON PostgREST Boundary on SERVER_ONLY_RPC ---");
    for (const t of serverOnlyHttpTargets) {
      const { data, error } = await unauthAnonClient.rpc(t.name, t.params);
      if (error && (error.message.includes("permission denied for function") || error.code === "42501" || error.status === 403)) {
        console.log(`[PASS] anon -> ${t.name}: DENIED as expected`);
      } else {
        console.error(`[FAIL] anon -> ${t.name} was NOT denied! Result:`, { data, error });
        allDenied = false;
      }
    }

    console.log("\n--- Testing AUTHENTICATED PostgREST Boundary on SERVER_ONLY_RPC ---");
    for (const t of serverOnlyHttpTargets) {
      const { data, error } = await authUserClient.rpc(t.name, t.params);
      if (error && (error.message.includes("permission denied for function") || error.code === "42501" || error.status === 403)) {
        console.log(`[PASS] auth -> ${t.name}: DENIED as expected`);
      } else {
        console.error(`[FAIL] auth -> ${t.name} was NOT denied! Result:`, { data, error });
        allDenied = false;
      }
    }

    console.log("\n--- Testing AUTHENTICATED_PLAYBACK_RPC PostgREST Boundary ---");
    // Anon MUST be denied
    const { error: anonPlaybackErr } = await unauthAnonClient.rpc("v5_authorize_agency_playback", {
      p_agency_id: dummyUuid,
      p_membership_id: dummyUuid,
      p_lesson_id: dummyUuid,
      p_asset_id: dummyUuid
    });
    if (anonPlaybackErr && (anonPlaybackErr.message.includes("permission denied for function") || anonPlaybackErr.code === "42501" || anonPlaybackErr.status === 401)) {
      console.log("[PASS] anon -> v5_authorize_agency_playback: DENIED as expected");
    } else {
      console.error("[FAIL] anon -> v5_authorize_agency_playback was NOT denied!", anonPlaybackErr);
      allDenied = false;
    }

    // Authenticated user MUST be permitted to execute (returns authorization payload, NOT permission denied 42501)
    const { data: authPlaybackData, error: authPlaybackErr } = await authUserClient.rpc("v5_authorize_agency_playback", {
      p_agency_id: dummyUuid,
      p_membership_id: dummyUuid,
      p_lesson_id: dummyUuid,
      p_asset_id: dummyUuid
    });
    if (authPlaybackErr && authPlaybackErr.message.includes("permission denied for function")) {
      console.error("[FAIL] auth -> v5_authorize_agency_playback failed with permission denied:", authPlaybackErr);
      allDenied = false;
    } else {
      console.log(`[PASS] auth -> v5_authorize_agency_playback executed business logic: ${JSON.stringify(authPlaybackData)}`);
    }

    console.log("\n--- Testing SERVICE_ROLE Execution (Controlled Positive Test) ---");
    const { data: sData, error: sError } = await adminClient.rpc("checkout_agency_offering", {
      p_agency_id: dummyUuid,
      p_membership_id: dummyUuid,
      p_offering_id: dummyUuid,
      p_bank_account_id: null,
      p_idempotency_order_code: "HEALTHCHECK"
    });
    if (sError && sError.message.includes("permission denied for function")) {
      console.error("[FAIL] service_role failed with permission denied:", sError);
      allDenied = false;
    } else {
      console.log(`[PASS] service_role -> checkout_agency_offering executed successfully: ${JSON.stringify(sData)}`);
    }

    if (!allDenied) {
      console.error("\nPRIVILEGED_RPC_TEST_COVERAGE = FAIL");
      process.exit(1);
    }

    console.log("\n=======================================================");
    console.log(`DISCOVERED_PUBLIC_FUNCTION_SIGNATURES = ${catalogFunctions.length}`);
    console.log(`SERVER_ONLY_SIGNATURE_COUNT = ${classified.SERVER_ONLY_RPC.length}`);
    console.log("UNCLASSIFIED_SIGNATURE_COUNT = 0");
    console.log("PRIVILEGED_RPC_TEST_COVERAGE = PASS");
    console.log("=======================================================");
  } finally {
    if (userId) {
      await adminClient.auth.admin.deleteUser(userId);
    }
  }
}

if (process.argv[1]?.endsWith("test-m0b1-phase-a-containment.js")) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
