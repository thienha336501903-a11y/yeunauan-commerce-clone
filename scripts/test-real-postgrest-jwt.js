// scripts/test-real-postgrest-jwt.js
// System B Milestone B2 & B3 — Real PostgREST Signed-JWT RPC Verification
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error("Missing required environment variables (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY).");
  process.exit(1);
}

// Admin client with service_role key
const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Client with anon key for user sign-in and public operations
const publicClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const timestamp = Date.now();
const testEmailA = `b2-test-a-${timestamp}@example.com`;
const testEmailB = `b2-test-b-${timestamp}@example.com`;
const testPassword = `P@ssw0rd_${crypto.randomBytes(8).toString("hex")}`;

const results = [];
function recordResult(testName, passed, detail) {
  results.push({ testName, passed, detail });
  const statusStr = passed ? "PASS" : "FAIL";
  console.log(`[${statusStr}] ${testName}: ${detail}`);
}

async function run() {
  console.log("===============================================================================");
  console.log("SYSTEM B MILESTONE B2: REAL POSTGREST SIGNED-JWT RPC TEST SUITE");
  console.log(`Target Supabase URL: ${SUPABASE_URL}`);
  console.log("===============================================================================\n");

  let userA = null;
  let userB = null;
  let tokenA = null;
  let agencyAlpha = null;
  let agencyBeta = null;
  let membershipA = null;
  let membershipB = null;
  let domainAlpha = null;

  try {
    // -------------------------------------------------------------------------
    // Setup Test Data
    // -------------------------------------------------------------------------
    console.log("1. Setting up test agencies, domains, and users...");

    // Create Agency Alpha
    const { data: aAlpha, error: errAlpha } = await adminClient
      .from("agencies")
      .insert({
        slug: `b2-agency-alpha-${timestamp}`,
        name: `B2 Test Agency Alpha ${timestamp}`,
        status: "active"
      })
      .select()
      .single();
    if (errAlpha) throw new Error(`Failed to create Agency Alpha: ${errAlpha.message}`);
    agencyAlpha = aAlpha;

    // Create Agency Beta
    const { data: aBeta, error: errBeta } = await adminClient
      .from("agencies")
      .insert({
        slug: `b2-agency-beta-${timestamp}`,
        name: `B2 Test Agency Beta ${timestamp}`,
        status: "active"
      })
      .select()
      .single();
    if (errBeta) throw new Error(`Failed to create Agency Beta: ${errBeta.message}`);
    agencyBeta = aBeta;

    // Create Agency Domain for Alpha
    const testHostname = `academy-${timestamp}.test.vn`;
    const { data: dAlpha, error: errDomain } = await adminClient
      .from("agency_domains")
      .insert({
        agency_id: agencyAlpha.id,
        hostname: testHostname,
        is_primary: true,
        ssl_status: "active",
        status: "active"
      })
      .select()
      .single();
    if (errDomain) throw new Error(`Failed to create Agency Domain: ${errDomain.message}`);
    domainAlpha = dAlpha;

    // Create User A
    const { data: authDataA, error: errAuthA } = await adminClient.auth.admin.createUser({
      email: testEmailA,
      password: testPassword,
      email_confirm: true
    });
    if (errAuthA) throw new Error(`Failed to create User A: ${errAuthA.message}`);
    userA = authDataA.user;

    // Create User B
    const { data: authDataB, error: errAuthB } = await adminClient.auth.admin.createUser({
      email: testEmailB,
      password: testPassword,
      email_confirm: true
    });
    if (errAuthB) throw new Error(`Failed to create User B: ${errAuthB.message}`);
    userB = authDataB.user;

    // Sign in User A via public GoTrue to get real signed JWT access_token
    const { data: signinDataA, error: errSigninA } = await publicClient.auth.signInWithPassword({
      email: testEmailA,
      password: testPassword
    });
    if (errSigninA) throw new Error(`Failed to sign in User A: ${errSigninA.message}`);
    tokenA = signinDataA.session.access_token;

    // Create Membership for User A in Agency Alpha
    const { data: memA, error: errMemA } = await adminClient
      .from("agency_memberships")
      .insert({
        agency_id: agencyAlpha.id,
        user_id: userA.id,
        role: "student",
        display_name: "Test Student A",
        status: "active"
      })
      .select()
      .single();
    if (errMemA) throw new Error(`Failed to create Membership A: ${errMemA.message}`);
    membershipA = memA;

    // Create Membership for User B in Agency Alpha
    const { data: memB, error: errMemB } = await adminClient
      .from("agency_memberships")
      .insert({
        agency_id: agencyAlpha.id,
        user_id: userB.id,
        role: "student",
        display_name: "Test Student B",
        status: "active"
      })
      .select()
      .single();
    if (errMemB) throw new Error(`Failed to create Membership B: ${errMemB.message}`);
    membershipB = memB;

    console.log("   Setup complete. Running test scenarios...\n");

    const rpcEndpoint = `${SUPABASE_URL}/rest/v1/rpc/v5_authorize_agency_playback`;
    const dummyLessonId = crypto.randomUUID();
    const dummyAssetId = crypto.randomUUID();

    // -------------------------------------------------------------------------
    // Scenario 1: Authenticated JWT with valid test user + matching membership
    // -------------------------------------------------------------------------
    const res1 = await fetch(rpcEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ANON_KEY,
        "Authorization": `Bearer ${tokenA}`
      },
      body: JSON.stringify({
        p_agency_id: agencyAlpha.id,
        p_membership_id: membershipA.id,
        p_lesson_id: dummyLessonId,
        p_asset_id: dummyAssetId
      })
    });
    const data1 = await res1.json();
    // Since dummyLessonId is not in lessons table, B1 RPC returns { authorized: false, code: "lesson_not_found" }
    // This demonstrates caller authentication was verified and membership validated!
    const passed1 = res1.status === 200 && data1.authorized === false && data1.code === "lesson_not_found";
    recordResult(
      "Scenario 1: Authenticated JWT with valid user + matching membership",
      passed1,
      `HTTP ${res1.status}, code: ${data1.code} (Identity & Membership verified)`
    );

    // -------------------------------------------------------------------------
    // Scenario 2: Authenticated JWT with another user's membership UUID
    // -------------------------------------------------------------------------
    const res2 = await fetch(rpcEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ANON_KEY,
        "Authorization": `Bearer ${tokenA}`
      },
      body: JSON.stringify({
        p_agency_id: agencyAlpha.id,
        p_membership_id: membershipB.id, // User B's membership UUID!
        p_lesson_id: dummyLessonId,
        p_asset_id: dummyAssetId
      })
    });
    const data2 = await res2.json();
    const passed2 = res2.status === 200 && data2.authorized === false && data2.code === "invalid_membership";
    recordResult(
      "Scenario 2: Authenticated JWT with another user's membership UUID",
      passed2,
      `HTTP ${res2.status}, code: ${data2.code}, error: ${data2.error}`
    );

    // -------------------------------------------------------------------------
    // Scenario 3: Authenticated JWT attempting to access another agency
    // -------------------------------------------------------------------------
    const res3 = await fetch(rpcEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ANON_KEY,
        "Authorization": `Bearer ${tokenA}`
      },
      body: JSON.stringify({
        p_agency_id: agencyBeta.id, // User A has no membership in Agency Beta!
        p_membership_id: membershipA.id,
        p_lesson_id: dummyLessonId,
        p_asset_id: dummyAssetId
      })
    });
    const data3 = await res3.json();
    const passed3 = res3.status === 200 && data3.authorized === false && data3.code === "agency_membership_not_found";
    recordResult(
      "Scenario 3: Authenticated JWT attempting to access wrong agency",
      passed3,
      `HTTP ${res3.status}, code: ${data3.code}, error: ${data3.error}`
    );

    // -------------------------------------------------------------------------
    // Scenario 4: Expired or tampered JWT fails with HTTP 401
    // -------------------------------------------------------------------------
    const fakeTamperedJwt = tokenA.slice(0, -10) + "tampered00";
    const res4 = await fetch(rpcEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ANON_KEY,
        "Authorization": `Bearer ${fakeTamperedJwt}`
      },
      body: JSON.stringify({
        p_agency_id: agencyAlpha.id,
        p_membership_id: membershipA.id,
        p_lesson_id: dummyLessonId,
        p_asset_id: dummyAssetId
      })
    });
    const passed4 = res4.status === 401;
    recordResult(
      "Scenario 4: Expired or tampered JWT fails at PostgREST boundary",
      passed4,
      `HTTP ${res4.status} (401 Unauthorized expected)`
    );

    // -------------------------------------------------------------------------
    // Scenario 5: Anonymous call without JWT fails closed (Revoked from anon)
    // -------------------------------------------------------------------------
    const res5 = await fetch(rpcEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ANON_KEY
        // No Authorization header
      },
      body: JSON.stringify({
        p_agency_id: agencyAlpha.id,
        p_membership_id: membershipA.id,
        p_lesson_id: dummyLessonId,
        p_asset_id: dummyAssetId
      })
    });
    const data5 = await res5.json().catch(() => ({}));
    // PostgREST returns 401 Unauthorized or 403 Forbidden with permission denied message
    const passed5 = res5.status === 401 || res5.status === 403 || (data5.message && data5.message.includes("permission denied"));
    recordResult(
      "Scenario 5: Anonymous call without authenticated JWT fails closed",
      passed5,
      `HTTP ${res5.status}, message: ${data5.message || data5.error || "Denied"}`
    );

    // -------------------------------------------------------------------------
    // Scenario 6: Authenticated JWT with spoofed headers has no effect
    // -------------------------------------------------------------------------
    const res6 = await fetch(rpcEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ANON_KEY,
        "Authorization": `Bearer ${tokenA}`,
        "x-user-id": userB.id,
        "x-agency-id": agencyBeta.id,
        "x-consumer-username": userB.id
      },
      body: JSON.stringify({
        p_agency_id: agencyAlpha.id,
        p_membership_id: membershipA.id,
        p_lesson_id: dummyLessonId,
        p_asset_id: dummyAssetId
      })
    });
    const data6 = await res6.json();
    // Caller is still strictly verified as user A; spoofed headers have zero effect
    const passed6 = res6.status === 200 && data6.authorized === false && data6.code === "lesson_not_found";
    recordResult(
      "Scenario 6: Authenticated JWT with spoofed headers has NO effect",
      passed6,
      `HTTP ${res6.status}, code: ${data6.code} (Identity strictly derived from JWT claims)`
    );

    // -------------------------------------------------------------------------
    // Scenario 7: B3 RPC resolve_agency_domain verification via PostgREST
    // -------------------------------------------------------------------------
    const domainRpcEndpoint = `${SUPABASE_URL}/rest/v1/rpc/resolve_agency_domain`;
    const res7 = await fetch(domainRpcEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ANON_KEY
      },
      body: JSON.stringify({
        p_hostname: testHostname
      })
    });
    const data7 = await res7.json();
    const passed7 = res7.status === 200 && data7.found === true && data7.agency_id === agencyAlpha.id;
    recordResult(
      "Scenario 7: B3 RPC resolve_agency_domain resolves active domain",
      passed7,
      `HTTP ${res7.status}, found: ${data7.found}, agency_id: ${data7.agency_id}`
    );

  } finally {
    // -------------------------------------------------------------------------
    // Teardown Test Data
    // -------------------------------------------------------------------------
    console.log("\n2. Cleaning up test data...");
    if (membershipA) {
      await adminClient.from("agency_memberships").delete().eq("id", membershipA.id);
    }
    if (membershipB) {
      await adminClient.from("agency_memberships").delete().eq("id", membershipB.id);
    }
    if (domainAlpha) {
      await adminClient.from("agency_domains").delete().eq("id", domainAlpha.id);
    }
    if (agencyAlpha) {
      await adminClient.from("agencies").delete().eq("id", agencyAlpha.id);
    }
    if (agencyBeta) {
      await adminClient.from("agencies").delete().eq("id", agencyBeta.id);
    }
    if (userA) {
      await adminClient.auth.admin.deleteUser(userA.id);
    }
    if (userB) {
      await adminClient.auth.admin.deleteUser(userB.id);
    }
    console.log("   Teardown complete.");
  }

  console.log("\n===============================================================================");
  console.log("SUMMARY OF REAL POSTGREST SIGNED-JWT RPC TESTS");
  console.log("===============================================================================");
  const allPassed = results.every(r => r.passed);
  console.log(`TOTAL SCENARIOS: ${results.length}`);
  console.log(`PASSED: ${results.filter(r => r.passed).length}`);
  console.log(`FAILED: ${results.filter(r => !r.passed).length}`);
  console.log(`POSTGREST_SIGNED_JWT_RPC_TEST = ${allPassed ? "PASS" : "FAIL"}`);
  console.log("===============================================================================\n");

  if (!allPassed) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution failed with unhandled error:", err);
  process.exit(1);
});
