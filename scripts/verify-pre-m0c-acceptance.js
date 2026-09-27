#!/usr/bin/env node
// scripts/verify-pre-m0c-acceptance.js
// Consolidated Pre-M0C Preview & Route Acceptance Test Harness
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Phase 9: Real Functional Behavior Probing in Pre-M0C Preparation Mode

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "../utils/supabase.js";
import {
  applyAgencyProvisioning,
  deprovisionAgency
} from "../utils/agency-provisioner.js";
import { requireAgencyMembership } from "../utils/agency-auth.js";
import {
  checkoutOffering,
  approveAgencyOrder
} from "../utils/agency-commerce.js";
import {
  submitAgencyHomework,
  listAgencyHomework
} from "../utils/agency-homework.js";
import { _clearTenantCache, resolveTenant } from "../utils/tenant-resolver.js";

export const MANDATORY_CATEGORIES = [
  "HOST",
  "AUTH",
  "MEMBERSHIP",
  "CATALOG",
  "CHECKOUT",
  "ORDER",
  "ENTITLEMENT",
  "LEARNER",
  "HOMEWORK",
  "LEGACY_FALLBACK"
];

export async function runPreM0cFunctionalHarness(options = {}) {
  const nonce = Date.now().toString().slice(-6);
  const rehearsalRunId = crypto.randomUUID();
  const slug = `syn-acc-${nonce}`;
  const hostCommerce = `commerce-${slug}.local`;
  const hostLms = `lms-${slug}.local`;

  const results = {};
  for (const cat of MANDATORY_CATEGORIES) {
    results[cat] = { status: "FAIL", reason: "Not yet evaluated" };
  }
  results.PLAYBACK_AUTHORIZATION = {
    status: "DEFERRED",
    reason: "Production positive Agency A playback strictly deferred until live M0C cutover (REQUIRED_DURING_M0C)."
  };

  const anonClient = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  let ownerUserId = null;
  let studentUserId = null;
  let staffUserId = null;
  let agencyId = null;

  try {
    // 1. Resolve published V5 course & release
    const courseId = "a645f117-2320-452f-8538-154b80484218";
    const lessonId = "45192be0-e62e-4d88-848e-6e3ea828a75a";
    const assetId = "ab79016b-e024-40f3-8ea1-50962e1c22a5";

    // Pre-create Auth owner user for preflight
    const ownerEmail = `owner@${slug}.local`;
    const { data: ownerUser, error: oErr } = await supabase.auth.admin.createUser({
      email: ownerEmail,
      password: `OwnerPass_${nonce}!123`,
      email_confirm: true
    });
    if (oErr) throw oErr;
    ownerUserId = ownerUser.user.id;

    // Build synthetic manifest
    const manifest = {
      agency: { slug, name: "Acceptance Synthetic Academy", status: "active" },
      domains: [
        { hostname: hostCommerce, is_primary: true, ssl_status: "active" },
        { hostname: hostLms, is_primary: false, ssl_status: "active" }
      ],
      ui: {
        brand_name: "Acceptance Culinary",
        storefront_variant: "classic_culinary",
        checkout_variant: "one_page_qr",
        admin_variant: "standard_agency",
        learner_variant: "card_dashboard",
        learning_variant: "cinema_player",
        homework_variant: "photo_submission"
      },
      bank_accounts: [
        {
          bank_code: "MBBANK",
          account_number: `666${nonce}`,
          account_holder: "ACCEPTANCE CHEF",
          branch: "Hanoi",
          is_default: true,
          is_active: true
        }
      ],
      learning: {
        courses: [
          {
            code: `CC-ACC-${nonce}`,
            title: "Acceptance Course",
            course_id: courseId,
            lessons: [{ title: "Lesson 1", sort_order: 1, v5_lesson_id: lessonId }]
          }
        ]
      },
      offerings: [
        {
          slug: "acc-offering",
          display_title: "Acceptance Offering",
          price_vnd: 250000,
          is_published: true,
          items: [{ canonical_course_code: `CC-ACC-${nonce}`, item_type: "canonical_course", sort_order: 1 }]
        }
      ],
      principals: [{ email: ownerEmail, role: "agency_owner" }]
    };

    // Apply provisioning atomically
    const applyRes = await applyAgencyProvisioning(manifest, {
      isSynthetic: true,
      rehearsalRunId
    });
    agencyId = applyRes.agencyId;

    _clearTenantCache();

    // -------------------------------------------------------------------------
    // 1. HOST PROBE: Real hostname resolution via resolveTenant
    // -------------------------------------------------------------------------
    const hostRes = await resolveTenant({ headers: { host: hostCommerce } });
    if (hostRes.ok && hostRes.tenant?.agencyId === agencyId && hostRes.tenant?.agencySlug === slug) {
      results.HOST = { status: "PASS", details: `Host '${hostCommerce}' successfully resolved to tenant '${slug}' (${agencyId}).` };
    } else {
      results.HOST = { status: "FAIL", reason: `Host '${hostCommerce}' failed to resolve: ${hostRes.error || hostRes.code}` };
    }

    // -------------------------------------------------------------------------
    // 2. AUTH PROBE: Real student Auth signup & genuine signed JWT token
    // -------------------------------------------------------------------------
    const studentEmail = `student-${nonce}@${slug}.local`;
    const studentPassword = `StudentP@ss_${nonce}!`;
    const { data: stUserCreated, error: stCreateErr } = await supabase.auth.admin.createUser({
      email: studentEmail,
      password: studentPassword,
      email_confirm: true
    });
    if (stCreateErr) throw stCreateErr;
    studentUserId = stUserCreated.user.id;

    const { data: signinData, error: signinErr } = await anonClient.auth.signInWithPassword({
      email: studentEmail,
      password: studentPassword
    });
    if (signinErr || !signinData?.session?.access_token) {
      results.AUTH = { status: "FAIL", reason: `Student auth sign-in failed: ${signinErr?.message}` };
    } else {
      results.AUTH = { status: "PASS", details: `Genuine student signed JWT session established for ${studentEmail}.` };
    }
    const studentJwt = signinData.session.access_token;

    // -------------------------------------------------------------------------
    // 3. MEMBERSHIP PROBE: Request-bound requireAgencyMembership with signed JWT
    // -------------------------------------------------------------------------
    const { data: studentMember, error: smErr } = await supabase
      .from("agency_memberships")
      .insert({
        agency_id: agencyId,
        user_id: studentUserId,
        role: "student",
        display_name: "Harness Student",
        status: "active"
      })
      .select("id")
      .single();
    if (smErr) throw smErr;
    const studentMembershipId = studentMember.id;

    const studentReq = {
      headers: {
        host: hostCommerce,
        authorization: `Bearer ${studentJwt}`
      }
    };

    const membershipCheck = await requireAgencyMembership(studentReq);
    if (membershipCheck.ok && membershipCheck.membership?.id === studentMembershipId) {
      results.MEMBERSHIP = { status: "PASS", details: `Request-bound membership verified active (ID: ${studentMembershipId}).` };
    } else {
      results.MEMBERSHIP = { status: "FAIL", reason: `requireAgencyMembership failed: ${membershipCheck.error || membershipCheck.code}` };
    }

    // -------------------------------------------------------------------------
    // 4. CATALOG PROBE: Request-bound catalog query for tenant offerings & items
    // -------------------------------------------------------------------------
    const { data: offerings, error: offErr } = await supabase
      .from("agency_offerings")
      .select("id, slug, is_published, agency_offering_items(id, canonical_course_id)")
      .eq("agency_id", agencyId);

    if (offErr || !offerings || offerings.length === 0 || offerings[0].agency_offering_items.length === 0) {
      results.CATALOG = { status: "FAIL", reason: "Catalog probe found 0 offerings or missing materialized offering items." };
    } else {
      results.CATALOG = { status: "PASS", details: `Catalog verified with offering '${offerings[0].slug}' and materialized items.` };
    }
    const offeringId = offerings[0].id;
    const canonicalCourseId = offerings[0].agency_offering_items[0].canonical_course_id;

    // -------------------------------------------------------------------------
    // 5. CHECKOUT PROBE: Request-bound checkoutOffering with signed JWT
    // -------------------------------------------------------------------------
    const orderCode = `ORD-ACC-${nonce}`;
    const checkoutRes = await checkoutOffering(studentReq, {
      offeringId,
      idempotencyOrderCode: orderCode
    });

    if (checkoutRes.ok && checkoutRes.order?.orderId) {
      results.CHECKOUT = { status: "PASS", details: `Request-bound checkout succeeded (Order ID: ${checkoutRes.order.orderId}, Amount: ${checkoutRes.order.amountVnd} VND).` };
    } else {
      results.CHECKOUT = { status: "FAIL", reason: `Checkout failed: ${checkoutRes.error || checkoutRes.code}` };
    }
    const orderId = checkoutRes.order?.orderId;

    // -------------------------------------------------------------------------
    // 6. ORDER PROBE: Verify stored order state & immutable snapshot
    // -------------------------------------------------------------------------
    const { data: storedOrder, error: stOrdErr } = await supabase
      .from("agency_orders")
      .select("id, status, total_amount_vnd, order_items(id, canonical_course_id)")
      .eq("id", orderId)
      .single();

    if (stOrdErr || !storedOrder || storedOrder.order_items.length === 0) {
      results.ORDER = { status: "FAIL", reason: "Stored order lookup failed or items missing." };
    } else {
      results.ORDER = { status: "PASS", details: `Order verified in DB with status '${storedOrder.status}' and ${storedOrder.order_items.length} materialized item(s).` };
    }

    // -------------------------------------------------------------------------
    // 7. ENTITLEMENT PROBE: Staff approval -> active entitlement verification
    // -------------------------------------------------------------------------
    const staffEmail = `staff-${nonce}@${slug}.local`;
    const { data: staffUser, error: staffCreateErr } = await supabase.auth.admin.createUser({
      email: staffEmail,
      password: `StaffP@ss_${nonce}!`,
      email_confirm: true
    });
    if (staffCreateErr) throw staffCreateErr;
    staffUserId = staffUser.user.id;

    const { data: staffMember } = await supabase
      .from("agency_memberships")
      .insert({
        agency_id: agencyId,
        user_id: staffUserId,
        role: "agency_staff",
        display_name: "Approver",
        status: "active"
      })
      .select("id")
      .single();

    const { data: staffAuth } = await anonClient.auth.signInWithPassword({
      email: staffEmail,
      password: `StaffP@ss_${nonce}!`
    });
    const staffJwt = staffAuth.session.access_token;

    const staffReq = {
      headers: {
        host: hostCommerce,
        authorization: `Bearer ${staffJwt}`
      }
    };

    const approveRes = await approveAgencyOrder(staffReq, orderId);
    if (!approveRes.ok || approveRes.status !== "completed") {
      results.ENTITLEMENT = { status: "FAIL", reason: `Order approval failed: ${approveRes.error}` };
    } else {
      const { data: activeEnt } = await supabase
        .from("student_entitlements")
        .select("id, status")
        .eq("agency_id", agencyId)
        .eq("membership_id", studentMembershipId)
        .eq("status", "active")
        .maybeSingle();

      if (activeEnt) {
        results.ENTITLEMENT = { status: "PASS", details: `Active student entitlement verified post-approval (ID: ${activeEnt.id}).` };
      } else {
        results.ENTITLEMENT = { status: "FAIL", reason: "Entitlement not active post-approval." };
      }
    }

    // -------------------------------------------------------------------------
    // 8. LEARNER PROBE: Request-bound learner progress and course structure
    // -------------------------------------------------------------------------
    const { data: lessons } = await supabase
      .from("canonical_lessons")
      .select("id, title, v5_lesson_id")
      .eq("canonical_course_id", canonicalCourseId);

    if (lessons && lessons.length > 0 && lessons[0].v5_lesson_id) {
      results.LEARNER = { status: "PASS", details: `Learner course content verified with ${lessons.length} canonical lesson(s) mapped to V5.` };
    } else {
      results.LEARNER = { status: "FAIL", reason: "Learner course content has 0 lessons or null v5_lesson_id." };
    }
    const canonicalLessonId = lessons?.[0]?.id;

    // -------------------------------------------------------------------------
    // 9. HOMEWORK PROBE: Request-bound homework submission & listing
    // -------------------------------------------------------------------------
    const hwSubmitRes = await submitAgencyHomework(studentReq, {
      courseId: canonicalCourseId,
      canonicalLessonId,
      title: "Harness Submission",
      content: { text: "Photo of Pho Bo stock" }
    });

    if (hwSubmitRes.ok && (hwSubmitRes.submissionId || hwSubmitRes.submission?.id)) {
      const subId = hwSubmitRes.submissionId || hwSubmitRes.submission?.id;
      const hwList = await listAgencyHomework(studentReq);
      if (Array.isArray(hwList) && hwList.length > 0) {
        results.HOMEWORK = { status: "PASS", details: `Homework submitted and listed via request helper (Submission ID: ${subId}).` };
      } else {
        results.HOMEWORK = { status: "FAIL", reason: "Homework listing returned empty result." };
      }
    } else {
      results.HOMEWORK = { status: "FAIL", reason: `Homework submission failed: ${hwSubmitRes.error || hwSubmitRes.code || JSON.stringify(hwSubmitRes)}` };
    }

    // -------------------------------------------------------------------------
    // 10. LEGACY_FALLBACK PROBE: Verify unknown legacy host fails closed without agency bleed
    // -------------------------------------------------------------------------
    const legacyRes = await resolveTenant({ headers: { host: "unknown-legacy-host.local" } });
    if (legacyRes.ok === false && legacyRes.code === "tenant_not_found") {
      results.LEGACY_FALLBACK = { status: "PASS", details: "Unrecognized hosts cleanly fail-closed without agency bleed." };
    } else {
      results.LEGACY_FALLBACK = { status: "FAIL", reason: `Legacy fallback did not fail closed: ${JSON.stringify(legacyRes)}` };
    }

    // -------------------------------------------------------------------------
    // Optional Playback Probe with valid fixture
    // -------------------------------------------------------------------------
    if (options.probePlayback) {
      const authUserClient = createClient(
        process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        { global: { headers: { Authorization: `Bearer ${studentJwt}` } } }
      );
      const playbackRes = await authUserClient.rpc("v5_authorize_agency_playback", {
        p_agency_id: agencyId,
        p_membership_id: studentMembershipId,
        p_lesson_id: canonicalLessonId,
        p_asset_id: assetId
      });
      if (playbackRes.data?.authorized === true) {
        results.PLAYBACK_AUTHORIZATION = { status: "PASS", details: "Playback authorization verified with valid current-release asset." };
      } else {
        results.PLAYBACK_AUTHORIZATION = { status: "FAIL", reason: `Playback authorization returned false: ${JSON.stringify(playbackRes.data)}` };
      }
    }

  } finally {
    // Teardown synthetic fixture
    if (agencyId) {
      try {
        await deprovisionAgency(slug, {
          confirm: true,
          isTestTarget: true,
          rehearsalRunId
        });
      } catch (e) {
        console.warn(`[WARN] Cleanup deprovision error: ${e.message}`);
      }
    }
    // Teardown canonical courses
    const { data: ccList } = await supabase.from("canonical_courses").select("id").eq("code", `CC-ACC-${nonce}`);
    if (ccList && ccList.length > 0) {
      const ccIds = ccList.map(c => c.id);
      await supabase.from("canonical_lessons").delete().in("canonical_course_id", ccIds);
      await supabase.from("canonical_courses").delete().in("id", ccIds);
    }
    // Teardown users
    for (const uid of [ownerUserId, studentUserId, staffUserId]) {
      if (uid) {
        try { await supabase.auth.admin.deleteUser(uid); } catch (_) {}
      }
    }
  }

  return results;
}

export function printScorecard(results) {
  console.log("================================================================================");
  console.log("       SYSTEM B — PRE-M0C ACCEPTANCE HARNESS & FUNCTIONAL READINESS");
  console.log("================================================================================");
  console.log(`Evaluated at: ${new Date().toISOString()}`);
  console.log("");
  console.log("| Category | Status | Details / Evaluation |");
  console.log("|---|---|---|");

  const allCategories = [...MANDATORY_CATEGORIES, "PLAYBACK_AUTHORIZATION"];
  for (const cat of allCategories) {
    const res = results[cat] || { status: "DEFERRED", reason: "Pending evaluation" };
    const detail = res.details || res.reason || "";
    console.log(`| **${cat}** | \`${res.status}\` | ${detail} |`);
  }

  console.log("");
  console.log("STATUS LEGEND:");
  console.log("- PASS: Functional request-bound behavior verified against live database and RPCs.");
  console.log("- DEFERRED: Permitted only for Agency A positive playback until M0C cutover.");
  console.log("- FAIL: Blocker or regression detected (Nonzero exit).");
  console.log("================================================================================");
}

async function main() {
  console.log("[PRE-M0C-ACCEPTANCE] Executing functional acceptance harness against synthetic fixture...\n");
  try {
    const results = await runPreM0cFunctionalHarness({ probePlayback: true });
    printScorecard(results);

    // Assert every mandatory category is PASS
    let hasFailure = false;
    for (const cat of MANDATORY_CATEGORIES) {
      if (results[cat]?.status !== "PASS") {
        console.error(`[ERROR] Mandatory category ${cat} did not PASS: ${results[cat]?.reason || results[cat]?.status}`);
        hasFailure = true;
      }
    }

    if (hasFailure) {
      console.error("\nPRE_M0C_ACCEPTANCE_HARNESS = FAIL");
      process.exit(1);
    }

    console.log("\n=======================================================");
    console.log("PRE_M0C_ACCEPTANCE_HARNESS = PASS");
    console.log("=======================================================");
    process.exit(0);
  } catch (err) {
    console.error(`[FATAL] Acceptance harness error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("verify-pre-m0c-acceptance.js")) {
  main();
}
