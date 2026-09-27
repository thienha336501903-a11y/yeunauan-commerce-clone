// test/second-tenant-isolation.test.js
// Automated test suite for System B Milestone Phase 13 & Pre-M0C Remediation V3: Second Tenant Isolation
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Invariants:
//   1. Two fully ready synthetic tenants: Alpha and Beta (domains, 6 UI variants, banks, offerings, canonical courses/lessons with v5_lesson_id, separate auth users & memberships).
//   2. Domain collision scenario: Beta trying to claim Alpha domain fails BEFORE any write, leaves ZERO partial state.
//   3. Positive request flows: A -> A succeeds; B -> B succeeds.
//   4. Negative TWO-WAY request isolation:
//      - A -> B host denied; B -> A host denied
//      - A cannot request-read/write B order, B entitlement, B homework
//      - B cannot request-read/write A order, A entitlement, A homework
//   5. Request-level isolation evidence only (no service-role filtered queries counted as evidence).
//   6. Clean teardown of both synthetic agencies using verified rehearsalRunId.

import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { supabase } from "../utils/supabase.js";
import { createClient } from "@supabase/supabase-js";
import {
  applyAgencyProvisioning,
  deprovisionAgency,
  verifyAgencyReadiness
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
import { _clearTenantCache } from "../utils/tenant-resolver.js";

test("SECOND-TENANT-ISOLATION: Strict Two-Way Request-Bound Boundary Enforcement Across Tenants", async (t) => {
  const rehearsalRunId = crypto.randomUUID();
  const nonce = Date.now().toString().slice(-6);
  const slugA = `tenant-a-${nonce}`;
  const slugB = `tenant-b-${nonce}`;

  const hostA1 = `shop-${slugA}.local`;
  const hostA2 = `lms-${slugA}.local`;
  const hostB1 = `shop-${slugB}.local`;
  const hostB2 = `lms-${slugB}.local`;

  // Exact two distinct V5 published courses, releases, lessons, and assets
  const courseIdA = "a645f117-2320-452f-8538-154b80484218";
  const lessonIdA = "45192be0-e62e-4d88-848e-6e3ea828a75a";
  const assetIdA = "ab79016b-e024-40f3-8ea1-50962e1c22a5";

  const courseIdB = "119bc49d-4227-4dde-af9c-f74a66842497";
  const lessonIdB = "d2dd9349-e112-44d7-8b8f-848fa3cdb396";
  const assetIdB = "a9cee883-780e-457b-87a2-0939204f64e5";

  // Pre-create Auth owner principals for preflight
  const ownerAEmail = `admin@${slugA}.local`;
  const { data: ownerUserA } = await supabase.auth.admin.createUser({
    email: ownerAEmail,
    password: `OwnerA_${nonce}!123`,
    email_confirm: true
  });
  const ownerBEmail = `admin@${slugB}.local`;
  const { data: ownerUserB } = await supabase.auth.admin.createUser({
    email: ownerBEmail,
    password: `OwnerB_${nonce}!123`,
    email_confirm: true
  });

  const manifestA = {
    agency: { slug: slugA, name: "Tenant Alpha Culinary", status: "active" },
    domains: [
      { hostname: hostA1, is_primary: true, ssl_status: "active" },
      { hostname: hostA2, is_primary: false, ssl_status: "active" }
    ],
    ui: {
      brand_name: "Alpha Culinary",
      storefront_variant: "classic_culinary",
      checkout_variant: "one_page_qr",
      admin_variant: "standard_agency",
      learner_variant: "card_dashboard",
      learning_variant: "cinema_player",
      homework_variant: "photo_submission"
    },
    bank_accounts: [
      {
        bank_code: "VCB",
        account_number: `111${nonce}`,
        account_holder: "ALPHA HOLDER",
        is_default: true,
        is_active: true
      }
    ],
    offerings: [
      {
        slug: "alpha-course",
        display_title: "Alpha Course",
        price_vnd: 200000,
        is_published: true,
        items: [{ canonical_course_code: `CC-ALPHA-${nonce}`, item_type: "canonical_course" }]
      }
    ],
    learning: {
      courses: [
        {
          code: `CC-ALPHA-${nonce}`,
          title: "Alpha Course",
          course_id: courseIdA,
          lessons: [{ title: "L1 Alpha", sort_order: 1, v5_lesson_id: lessonIdA }]
        }
      ]
    },
    principals: [{ email: `admin@${slugA}.local`, role: "agency_owner" }]
  };

  const manifestB = {
    agency: { slug: slugB, name: "Tenant Beta Pastry", status: "active" },
    domains: [
      { hostname: hostB1, is_primary: true, ssl_status: "active" },
      { hostname: hostB2, is_primary: false, ssl_status: "active" }
    ],
    ui: {
      brand_name: "Beta Pastry",
      storefront_variant: "modern_minimal",
      checkout_variant: "one_page_qr",
      admin_variant: "standard_agency",
      learner_variant: "card_dashboard",
      learning_variant: "cinema_player",
      homework_variant: "photo_submission"
    },
    bank_accounts: [
      {
        bank_code: "TCB",
        account_number: `222${nonce}`,
        account_holder: "BETA HOLDER",
        is_default: true,
        is_active: true
      }
    ],
    offerings: [
      {
        slug: "beta-course",
        display_title: "Beta Course",
        price_vnd: 300000,
        is_published: true,
        items: [{ canonical_course_code: `CC-BETA-${nonce}`, item_type: "canonical_course" }]
      }
    ],
    learning: {
      courses: [
        {
          code: `CC-BETA-${nonce}`,
          title: "Beta Course",
          course_id: courseIdB,
          lessons: [{ title: "L1 Beta", sort_order: 1, v5_lesson_id: lessonIdB }]
        }
      ]
    },
    principals: [{ email: `admin@${slugB}.local`, role: "agency_owner" }]
  };

  let agencyIdA = null;
  let agencyIdB = null;
  let studentUserA = null;
  let studentUserB = null;
  let memberIdA = null;
  let memberIdB = null;
  let userJwtA = null;
  let userJwtB = null;

  let offeringIdA = null;
  let offeringIdB = null;
  let orderIdA = null;
  let orderIdB = null;
  let canonicalCourseIdA = null;
  let canonicalLessonIdA = null;
  let canonicalCourseIdB = null;
  let canonicalLessonIdB = null;

  const anonClient = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  try {
    // -------------------------------------------------------------------------
    // 1. PROVISION TENANT ALPHA
    // -------------------------------------------------------------------------
    await t.test("O.1: Provision Tenant Alpha with 6 UI profiles and full readiness", async () => {
      const resA = await applyAgencyProvisioning(manifestA, { isSynthetic: true, isTestTarget: true, rehearsalRunId });
      assert.equal(resA.ok, true);
      agencyIdA = resA.agencyId;

      const { data: offA } = await supabase.from("agency_offerings").select("id").eq("agency_id", agencyIdA).single();
      offeringIdA = offA.id;

      const { data: ccA } = await supabase.from("canonical_courses").select("id").eq("code", `CC-ALPHA-${nonce}`).single();
      canonicalCourseIdA = ccA.id;
      const { data: clA } = await supabase.from("canonical_lessons").select("id").eq("canonical_course_id", ccA.id).single();
      canonicalLessonIdA = clA.id;
    });

    // -------------------------------------------------------------------------
    // 2. DOMAIN COLLISION: BETA TRYING TO CLAIM ALPHA DOMAIN FAILS BEFORE ANY WRITE
    // -------------------------------------------------------------------------
    await t.test("O.2: Domain collision scenario: Beta trying to claim Alpha domain fails BEFORE any write", async () => {
      const collisionManifest = JSON.parse(JSON.stringify(manifestB));
      collisionManifest.domains[0].hostname = hostA1; // Conflict with Alpha domain!

      await assert.rejects(
        async () => {
          await applyAgencyProvisioning(collisionManifest, { isSynthetic: true, isTestTarget: true, rehearsalRunId });
        },
        /Domain collision detected|domain_ownership_conflict/
      );

      // Verify NO partial agency row was created for Beta!
      const { data: partialBeta } = await supabase.from("agencies").select("id").eq("slug", slugB).maybeSingle();
      assert.equal(partialBeta, null, "No partial agency record may be created if domain collision exists");
    });

    // -------------------------------------------------------------------------
    // 3. PROVISION TENANT BETA
    // -------------------------------------------------------------------------
    await t.test("O.3: Provision Tenant Beta with unique isolated domains and full readiness", async () => {
      const resB = await applyAgencyProvisioning(manifestB, { isSynthetic: true, isTestTarget: true, rehearsalRunId });
      assert.equal(resB.ok, true);
      agencyIdB = resB.agencyId;
      assert.notEqual(agencyIdA, agencyIdB);

      const { data: offB } = await supabase.from("agency_offerings").select("id").eq("agency_id", agencyIdB).single();
      offeringIdB = offB.id;

      const { data: ccB } = await supabase.from("canonical_courses").select("id").eq("code", `CC-BETA-${nonce}`).single();
      canonicalCourseIdB = ccB.id;
      const { data: clB } = await supabase.from("canonical_lessons").select("id").eq("canonical_course_id", ccB.id).single();
      canonicalLessonIdB = clB.id;
    });

    // -------------------------------------------------------------------------
    // 4. SETUP SEPARATE AUTH USERS AND MEMBERSHIPS
    // -------------------------------------------------------------------------
    await t.test("O.4: Setup separate authenticated users and memberships for Alpha and Beta", async () => {
      // User A
      const emailA = `student-a-${nonce}@alpha.local`;
      const passA = `PassA_${nonce}!123`;
      const { data: uA, error: uAErr } = await supabase.auth.admin.createUser({
        email: emailA,
        password: passA,
        email_confirm: true
      });
      assert.ifError(uAErr);
      studentUserA = uA.user.id;

      const { data: signinA, error: signinAErr } = await anonClient.auth.signInWithPassword({
        email: emailA,
        password: passA
      });
      assert.ifError(signinAErr);
      userJwtA = signinA.session.access_token;

      const { data: memA, error: memAErr } = await supabase
        .from("agency_memberships")
        .insert({
          agency_id: agencyIdA,
          user_id: studentUserA,
          role: "student",
          display_name: "Student Alpha",
          phone: `0911${nonce}`
        })
        .select("id")
        .single();
      assert.ifError(memAErr);
      memberIdA = memA.id;

      // User B
      const emailB = `student-b-${nonce}@beta.local`;
      const passB = `PassB_${nonce}!123`;
      const { data: uB, error: uBErr } = await supabase.auth.admin.createUser({
        email: emailB,
        password: passB,
        email_confirm: true
      });
      assert.ifError(uBErr);
      studentUserB = uB.user.id;

      const { data: signinB, error: signinBErr } = await anonClient.auth.signInWithPassword({
        email: emailB,
        password: passB
      });
      assert.ifError(signinBErr);
      userJwtB = signinB.session.access_token;

      const { data: memB, error: memBErr } = await supabase
        .from("agency_memberships")
        .insert({
          agency_id: agencyIdB,
          user_id: studentUserB,
          role: "student",
          display_name: "Student Beta",
          phone: `0922${nonce}`
        })
        .select("id")
        .single();
      assert.ifError(memBErr);
      memberIdB = memB.id;
    });

    // -------------------------------------------------------------------------
    // 5. POSITIVE REQUEST FLOW: A -> A SUCCEEDS & B -> B SUCCEEDS
    // -------------------------------------------------------------------------
    await t.test("O.5: Positive request flows: A -> A succeeds and B -> B succeeds", async () => {
      _clearTenantCache();

      // A -> A Checkout
      const reqA = {
        headers: { host: hostA1, authorization: `Bearer ${userJwtA}` }
      };
      const checkoutResA = await checkoutOffering(reqA, {
        offeringId: offeringIdA,
        idempotencyOrderCode: `ORD-A-${nonce}`
      });
      assert.equal(checkoutResA.ok, true);
      assert.equal(checkoutResA.order.status, "pending");
      orderIdA = checkoutResA.order.orderId;

      // Grant entitlement directly for positive flow testing
      await supabase.from("student_entitlements").insert({
        agency_id: agencyIdA,
        membership_id: memberIdA,
        canonical_course_id: canonicalCourseIdA,
        status: "active"
      });

      // A -> A Homework submission and listing
      const submitA = await submitAgencyHomework(reqA, {
        courseId: canonicalCourseIdA,
        canonicalLessonId: canonicalLessonIdA,
        title: "Homework from Alpha Student",
        content: { text: "Alpha homework content" }
      });
      assert.equal(submitA.ok, true);
      assert.equal(submitA.agencyId, agencyIdA);

      const listA = await listAgencyHomework(reqA);
      assert.ok(Array.isArray(listA));
      assert.ok(listA.length >= 1);
      assert.equal(listA[0].agency_id, agencyIdA);

      // B -> B Checkout
      const reqB = {
        headers: { host: hostB1, authorization: `Bearer ${userJwtB}` }
      };
      const checkoutResB = await checkoutOffering(reqB, {
        offeringId: offeringIdB,
        idempotencyOrderCode: `ORD-B-${nonce}`
      });
      assert.equal(checkoutResB.ok, true);
      assert.equal(checkoutResB.order.status, "pending");
      orderIdB = checkoutResB.order.orderId;

      // Grant entitlement directly for B
      await supabase.from("student_entitlements").insert({
        agency_id: agencyIdB,
        membership_id: memberIdB,
        canonical_course_id: canonicalCourseIdB,
        status: "active"
      });

      // B -> B Homework submission and listing
      const submitB = await submitAgencyHomework(reqB, {
        courseId: canonicalCourseIdB,
        canonicalLessonId: canonicalLessonIdB,
        title: "Homework from Beta Student",
        content: { text: "Beta homework content" }
      });
      assert.equal(submitB.ok, true);
      assert.equal(submitB.agencyId, agencyIdB);

      const listB = await listAgencyHomework(reqB);
      assert.ok(Array.isArray(listB));
      assert.ok(listB.length >= 1);
      assert.equal(listB[0].agency_id, agencyIdB);

      // Verify both tenants pass readiness gates
      const readyA = await verifyAgencyReadiness(slugA);
      assert.equal(readyA.ok, true, "Alpha tenant must pass verifyAgencyReadiness");
      const readyB = await verifyAgencyReadiness(slugB);
      assert.equal(readyB.ok, true, "Beta tenant must pass verifyAgencyReadiness");

      // Positive Playback Authorization with valid current-release assets
      const authUserClientA = createClient(
        process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        { global: { headers: { Authorization: `Bearer ${userJwtA}` } } }
      );
      const positivePlaybackA = await authUserClientA.rpc("v5_authorize_agency_playback", {
        p_agency_id: agencyIdA,
        p_membership_id: memberIdA,
        p_lesson_id: canonicalLessonIdA,
        p_asset_id: assetIdA
      });
      assert.equal(positivePlaybackA.data?.authorized, true, "Student A on Tenant A with valid asset must be authorized");

      const authUserClientB = createClient(
        process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        { global: { headers: { Authorization: `Bearer ${userJwtB}` } } }
      );
      const positivePlaybackB = await authUserClientB.rpc("v5_authorize_agency_playback", {
        p_agency_id: agencyIdB,
        p_membership_id: memberIdB,
        p_lesson_id: canonicalLessonIdB,
        p_asset_id: assetIdB
      });
      assert.equal(positivePlaybackB.data?.authorized, true, "Student B on Tenant B with valid asset must be authorized");

      // Positive Request-Bound Order Reads
      const { data: ordAData, error: ordAErr } = await authUserClientA
        .from("agency_orders")
        .select("id, status")
        .eq("id", orderIdA)
        .single();
      assert.ifError(ordAErr);
      assert.equal(ordAData.id, orderIdA);

      const { data: ordBData, error: ordBErr } = await authUserClientB
        .from("agency_orders")
        .select("id, status")
        .eq("id", orderIdB)
        .single();
      assert.ifError(ordBErr);
      assert.equal(ordBData.id, orderIdB);

      // Positive Request-Bound Entitlement Reads
      const { data: entAData, error: entAErr } = await authUserClientA
        .from("student_entitlements")
        .select("id, status")
        .eq("agency_id", agencyIdA)
        .single();
      assert.ifError(entAErr);
      assert.equal(entAData.status, "active");

      const { data: entBData, error: entBErr } = await authUserClientB
        .from("student_entitlements")
        .select("id, status")
        .eq("agency_id", agencyIdB)
        .single();
      assert.ifError(entBErr);
      assert.equal(entBData.status, "active");
    });

    // -------------------------------------------------------------------------
    // 6. NEGATIVE TWO-WAY REQUEST ISOLATION: A -> B DENIED & B -> A DENIED
    // -------------------------------------------------------------------------
    await t.test("O.6: Negative two-way request isolation: Host, Order, Entitlement, Homework boundaries", async () => {
      _clearTenantCache();

      // 6.1 Host authentication denial
      // User A token on Host B
      const reqA_on_B = {
        headers: { host: hostB1, authorization: `Bearer ${userJwtA}` }
      };
      const authA_on_B = await requireAgencyMembership(reqA_on_B);
      assert.equal(authA_on_B.ok, false);
      assert.equal(authA_on_B.status, 403);
      assert.ok(["membership_not_found", "membership_required"].includes(authA_on_B.code));

      // User B token on Host A
      const reqB_on_A = {
        headers: { host: hostA1, authorization: `Bearer ${userJwtB}` }
      };
      const authB_on_A = await requireAgencyMembership(reqB_on_A);
      assert.equal(authB_on_A.ok, false);
      assert.equal(authB_on_A.status, 403);
      assert.ok(["membership_not_found", "membership_required"].includes(authB_on_A.code));

      // 6.2 Cross-tenant Order denial (A cannot checkout or read B orders)
      const crossOrderA = await checkoutOffering(reqA_on_B, {
        offeringId: offeringIdB,
        idempotencyOrderCode: `CROSS-A-${nonce}`
      });
      assert.equal(crossOrderA.ok, false);
      assert.equal(crossOrderA.status, 403);

      const crossOrderB = await checkoutOffering(reqB_on_A, {
        offeringId: offeringIdA,
        idempotencyOrderCode: `CROSS-B-${nonce}`
      });
      assert.equal(crossOrderB.ok, false);
      assert.equal(crossOrderB.status, 403);

      // Cross-tenant Order read denial
      const { data: crossOrdA } = await authUserClientA
        .from("agency_orders")
        .select("id")
        .eq("id", orderIdB)
        .maybeSingle();
      assert.equal(crossOrdA, null, "Student A cannot read Tenant B's order");

      const { data: crossOrdB } = await authUserClientB
        .from("agency_orders")
        .select("id")
        .eq("id", orderIdA)
        .maybeSingle();
      assert.equal(crossOrdB, null, "Student B cannot read Tenant A's order");

      // Cross-tenant Entitlement read denial
      const { data: crossEntA } = await authUserClientA
        .from("student_entitlements")
        .select("id")
        .eq("agency_id", agencyIdB)
        .maybeSingle();
      assert.equal(crossEntA, null, "Student A cannot read Tenant B's entitlement");

      const { data: crossEntB } = await authUserClientB
        .from("student_entitlements")
        .select("id")
        .eq("agency_id", agencyIdA)
        .maybeSingle();
      assert.equal(crossEntB, null, "Student B cannot read Tenant A's entitlement");

      // 6.3 Cross-tenant Playback RPC denial with VALID current-release assets
      const authUserClientA = createClient(
        process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        { global: { headers: { Authorization: `Bearer ${userJwtA}` } } }
      );
      const authUserClientB = createClient(
        process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        { global: { headers: { Authorization: `Bearer ${userJwtB}` } } }
      );

      // Student A attempting to playback Tenant B's REAL valid asset on Tenant B -> DENIED
      const crossPlaybackA = await authUserClientA.rpc("v5_authorize_agency_playback", {
        p_agency_id: agencyIdB,
        p_membership_id: memberIdA,
        p_lesson_id: canonicalLessonIdB,
        p_asset_id: assetIdB
      });
      assert.equal(crossPlaybackA.data?.authorized, false, "Cross-tenant playback A on B must be denied");

      // Student B attempting to playback Tenant A's REAL valid asset on Tenant A -> DENIED
      const crossPlaybackB = await authUserClientB.rpc("v5_authorize_agency_playback", {
        p_agency_id: agencyIdA,
        p_membership_id: memberIdB,
        p_lesson_id: canonicalLessonIdA,
        p_asset_id: assetIdA
      });
      assert.equal(crossPlaybackB.data?.authorized, false, "Cross-tenant playback B on A must be denied");

      // 6.4 Cross-tenant Homework denial
      // A cannot submit homework to B
      const crossHwSubmitA = await submitAgencyHomework(reqA_on_B, {
        courseId: canonicalCourseIdB,
        canonicalLessonId: canonicalLessonIdB,
        title: "Malicious submission from A",
        content: {}
      });
      assert.equal(crossHwSubmitA.ok, false);
      assert.equal(crossHwSubmitA.status, 403);

      // B cannot submit homework to A
      const crossHwSubmitB = await submitAgencyHomework(reqB_on_A, {
        courseId: canonicalCourseIdA,
        canonicalLessonId: canonicalLessonIdA,
        title: "Malicious submission from B",
        content: {}
      });
      assert.equal(crossHwSubmitB.ok, false);
      assert.equal(crossHwSubmitB.status, 403);

      // A cannot list homework from B
      const crossHwListA = await listAgencyHomework(reqA_on_B);
      assert.equal(crossHwListA.ok, false);
      assert.equal(crossHwListA.status, 403);

      // B cannot list homework from A
      const crossHwListB = await listAgencyHomework(reqB_on_A);
      assert.equal(crossHwListB.ok, false);
      assert.equal(crossHwListB.status, 403);
    });
  } finally {
    // -------------------------------------------------------------------------
    // 7. TEARDOWN BOTH TENANTS & FIXTURES WITH VERIFIED REHEARSAL RUN ID
    // -------------------------------------------------------------------------
    await t.test("O.7: Teardown both synthetic tenants completely", async () => {
      if (agencyIdA) {
        await deprovisionAgency(slugA, { confirm: true, isTestTarget: true, rehearsalRunId });
      }
      if (agencyIdB) {
        await deprovisionAgency(slugB, { confirm: true, isTestTarget: true, rehearsalRunId });
      }

      if (studentUserA) {
        try { await supabase.auth.admin.deleteUser(studentUserA); } catch (_) {}
      }
      if (studentUserB) {
        try { await supabase.auth.admin.deleteUser(studentUserB); } catch (_) {}
      }

      // Clean up canonical courses created for test
      const { data: ccList } = await supabase.from("canonical_courses").select("id").in("code", [`CC-ALPHA-${nonce}`, `CC-BETA-${nonce}`]);
      if (ccList && ccList.length > 0) {
        const ccIds = ccList.map(c => c.id);
        await supabase.from("canonical_lessons").delete().in("canonical_course_id", ccIds);
        await supabase.from("canonical_courses").delete().in("id", ccIds);
      }

      try {
        const { data: uList } = await supabase.auth.admin.listUsers();
        for (const email of [`admin@${slugA}.local`, `admin@${slugB}.local`]) {
          const match = uList?.users?.find((u) => u.email === email);
          if (match) await supabase.auth.admin.deleteUser(match.id);
        }
      } catch (_) {}
    });
  }
});
