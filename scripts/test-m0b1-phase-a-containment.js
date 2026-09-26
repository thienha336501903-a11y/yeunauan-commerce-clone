// scripts/test-m0b1-phase-a-containment.js
// Verification script for M0B.1 / Pre-M0C Remediation V2 Phase 15 RPC Containment
// Dynamically verifies that all privileged server-only RPC signatures are revoked
// from BOTH anon and authenticated PostgREST roles.

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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

async function main() {
  console.log("=== PRE-M0C PHASE 15 PRIVILEGED RPC CONTAINMENT SUITE ===");
  console.log(`Target: ${SUPABASE_URL}\n`);

  const testEmail = `phase-a-test-${Date.now()}@example.com`;
  const testPassword = `TestP@ss_${crypto.randomBytes(8).toString("hex")}`;
  let userId = null;

  try {
    // 1. Create a real authenticated user
    const { data: userCreated, error: createError } = await adminClient.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true
    });
    if (createError) throw createError;
    userId = userCreated.user.id;

    // 2. Sign in as authenticated user to get genuine signed JWT
    const { data: signinData, error: signinError } = await anonClient.auth.signInWithPassword({
      email: testEmail,
      password: testPassword
    });
    if (signinError) throw signinError;
    const userJwt = signinData.session.access_token;

    // Authenticated client using user's signed JWT
    const authUserClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${userJwt}` } },
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const dummyUuid = "00000000-0000-0000-0000-000000000000";

    // All known privileged server-only RPC signatures (covering all overloads)
    const targets = [
      {
        name: "checkout_agency_offering",
        rpc: "checkout_agency_offering",
        params: {
          p_agency_id: dummyUuid,
          p_membership_id: dummyUuid,
          p_offering_id: dummyUuid,
          p_bank_account_id: dummyUuid,
          p_idempotency_order_code: "TEST1234"
        }
      },
      {
        name: "approve_agency_order",
        rpc: "approve_agency_order",
        params: {
          p_agency_id: dummyUuid,
          p_order_id: dummyUuid,
          p_approved_by_membership_id: dummyUuid
        }
      },
      {
        name: "refund_agency_order",
        rpc: "refund_agency_order",
        params: {
          p_agency_id: dummyUuid,
          p_order_id: dummyUuid,
          p_reason: "Test refund"
        }
      },
      {
        name: "recompute_effective_entitlement",
        rpc: "recompute_effective_entitlement",
        params: {
          p_agency_id: dummyUuid,
          p_entitlement_id: dummyUuid
        }
      },
      {
        name: "submit_agency_homework (canonical_lesson_id UUID overload)",
        rpc: "submit_agency_homework",
        params: {
          p_agency_id: dummyUuid,
          p_membership_id: dummyUuid,
          p_canonical_course_id: dummyUuid,
          p_canonical_lesson_id: dummyUuid,
          p_title: "Test HW UUID",
          p_content: {}
        }
      },
      {
        name: "submit_agency_homework (lesson_id TEXT overload)",
        rpc: "submit_agency_homework",
        params: {
          p_agency_id: dummyUuid,
          p_membership_id: dummyUuid,
          p_canonical_course_id: dummyUuid,
          p_lesson_id: "test",
          p_title: "Test HW TEXT",
          p_content: {}
        }
      },
      {
        name: "grade_agency_homework",
        rpc: "grade_agency_homework",
        params: {
          p_agency_id: dummyUuid,
          p_staff_membership_id: dummyUuid,
          p_submission_id: dummyUuid,
          p_status: "evaluated",
          p_feedback: "Test",
          p_score: 10
        }
      }
    ];

    let allDenied = true;

    // Test anon PostgREST boundary
    console.log("--- 1. Testing ANON PostgREST Access (Must All Be DENIED) ---");
    for (const t of targets) {
      const { data, error } = await anonClient.rpc(t.rpc, t.params);
      if (error && (error.message.includes("permission denied for function") || error.code === "42501")) {
        console.log(`[PASS] anon -> ${t.name}: DENIED as expected`);
      } else {
        console.error(`[FAIL] anon -> ${t.name} was NOT denied! Result:`, { data, error });
        allDenied = false;
      }
    }

    // Test authenticated PostgREST boundary
    console.log("\n--- 2. Testing AUTHENTICATED PostgREST Access (Must All Be DENIED) ---");
    for (const t of targets) {
      const { data, error } = await authUserClient.rpc(t.rpc, t.params);
      if (error && (error.message.includes("permission denied for function") || error.code === "42501")) {
        console.log(`[PASS] auth -> ${t.name}: DENIED as expected`);
      } else {
        console.error(`[FAIL] auth -> ${t.name} was NOT denied! Result:`, { data, error });
        allDenied = false;
      }
    }

    // Test controlled service_role execution (Must NOT receive permission denied)
    console.log("\n--- 3. Testing SERVICE_ROLE Execution (Controlled Positive Test) ---");
    const { data: sData, error: sError } = await adminClient.rpc("checkout_agency_offering", {
      p_agency_id: dummyUuid,
      p_membership_id: dummyUuid,
      p_offering_id: dummyUuid,
      p_bank_account_id: null,
      p_idempotency_order_code: "HEALTHCHECK"
    });
    // It should execute logic (and return agency_not_found), NOT permission denied!
    if (sError && sError.message.includes("permission denied for function")) {
      console.error("[FAIL] service_role failed with permission denied:", sError);
      allDenied = false;
    } else {
      console.log(`[PASS] service_role -> checkout_agency_offering executed correctly (Result: ${JSON.stringify(sData)})`);
    }

    if (!allDenied) {
      console.error("\nPRIVILEGED_RPC_TEST_COVERAGE = FAIL");
      process.exit(1);
    }

    console.log("\n=======================================================");
    console.log("PRIVILEGED_RPC_TEST_COVERAGE = PASS (All 7 signatures denied to anon and auth)");
    console.log("=======================================================");
  } finally {
    if (userId) {
      await adminClient.auth.admin.deleteUser(userId);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
