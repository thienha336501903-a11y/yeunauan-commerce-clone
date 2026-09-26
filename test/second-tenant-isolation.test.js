// test/second-tenant-isolation.test.js
// Automated test suite for System B Milestone Phase 13: Second Tenant Isolation
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Invariants:
//   1. Domain collision scenario: Beta trying to claim Alpha domain fails BEFORE any write.
//   2. Cross-tenant auth: Alpha token rejected on Beta host.
//   3. Cross-tenant order: Alpha member cannot checkout on Beta.
//   4. Cross-tenant entitlement: Alpha grant does not grant Beta.
//   5. Cross-tenant playback RPC: Alpha member cannot playback Beta lesson.
//   6. Clean teardown of both synthetic agencies using verified rehearsalRunId.

import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { supabase } from "../utils/supabase.js";
import { createClient } from "@supabase/supabase-js";
import {
  applyAgencyProvisioning,
  deprovisionAgency
} from "../utils/agency-provisioner.js";
import { resolveRequestRoute } from "../utils/agency-routing.js";
import { requireAgencyMembership } from "../utils/agency-auth.js";

test("SECOND-TENANT-ISOLATION: Strict Boundary Enforcement Across Multiple Tenants", async (t) => {
  const rehearsalRunId = `second-tenant-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const nonce = Date.now().toString().slice(-6);
  const slugA = `tenant-a-${nonce}`;
  const slugB = `tenant-b-${nonce}`;

  const hostA1 = `shop-${slugA}.local`;
  const hostA2 = `lms-${slugA}.local`;
  const hostB1 = `shop-${slugB}.local`;
  const hostB2 = `lms-${slugB}.local`;

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
    bank_accounts: [{ bank_code: "VCB", account_number: `111${nonce}`, account_holder: "ALPHA HOLDER" }],
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
          lessons: [{ title: "L1", sort_order: 1 }]
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
    bank_accounts: [{ bank_code: "TCB", account_number: `222${nonce}`, account_holder: "BETA HOLDER" }],
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
          lessons: [{ title: "L1", sort_order: 1 }]
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

  try {
    // -------------------------------------------------------------------------
    // 1. PROVISION TENANT ALPHA
    // -------------------------------------------------------------------------
    await t.test("O.1: Provision Tenant Alpha", async () => {
      const resA = await applyAgencyProvisioning(manifestA, { isSynthetic: true, rehearsalRunId });
      assert.equal(resA.ok, true);
      agencyIdA = resA.agencyId;
    });

    // -------------------------------------------------------------------------
    // 2. DOMAIN COLLISION: BETA TRYING TO CLAIM ALPHA DOMAIN FAILS BEFORE ANY WRITE
    // -------------------------------------------------------------------------
    await t.test("O.2: Domain collision scenario: Beta trying to claim Alpha domain fails BEFORE any write", async () => {
      const collisionManifest = JSON.parse(JSON.stringify(manifestB));
      collisionManifest.domains[0].hostname = hostA1; // Conflict with Alpha domain!

      await assert.rejects(
        async () => {
          await applyAgencyProvisioning(collisionManifest, { isSynthetic: true, rehearsalRunId });
        },
        /SECURITY VIOLATION: Domain collision detected/
      );

      // Verify NO partial agency row was created for Beta!
      const { data: partialBeta } = await supabase.from("agencies").select("id").eq("slug", slugB).maybeSingle();
      assert.equal(partialBeta, null, "No partial agency record may be created if domain collision exists");
    });

    // -------------------------------------------------------------------------
    // 3. PROVISION TENANT BETA
    // -------------------------------------------------------------------------
    await t.test("O.3: Provision Tenant Beta with unique isolated domains", async () => {
      const resB = await applyAgencyProvisioning(manifestB, { isSynthetic: true, rehearsalRunId });
      assert.equal(resB.ok, true);
      agencyIdB = resB.agencyId;
      assert.notEqual(agencyIdA, agencyIdB);
    });

    // -------------------------------------------------------------------------
    // 4. CROSS-TENANT AUTH: ALPHA TOKEN REJECTED ON BETA HOST
    // -------------------------------------------------------------------------
    await t.test("O.4: Cross-tenant auth: Alpha token rejected on Beta host", async () => {
      // Create user A in auth.users & get JWT
      const emailA = `student-a-${nonce}@alpha.local`;
      const passA = `PassA_${nonce}!123`;
      const { data: uA } = await supabase.auth.admin.createUser({
        email: emailA,
        password: passA,
        email_confirm: true
      });
      studentUserA = uA.user.id;

      const anonClient = createClient(
        process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      );
      const { data: signinA, error: signinAErr } = await anonClient.auth.signInWithPassword({
        email: emailA,
        password: passA
      });
      assert.ifError(signinAErr);
      userJwtA = signinA.session.access_token;

      // Add membership for studentUserA in Agency A
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

      // Request sent to Beta host with Alpha user's token
      const reqBeta = {
        headers: {
          host: hostB1,
          authorization: `Bearer ${userJwtA}`
        }
      };

      const authResult = await requireAgencyMembership(reqBeta);
      assert.equal(authResult.ok, false);
      assert.equal(authResult.status, 403);
      assert.ok(["membership_not_found", "membership_required"].includes(authResult.code));
    });

    // -------------------------------------------------------------------------
    // 5. CROSS-TENANT ORDER: ALPHA MEMBER CANNOT CHECKOUT ON BETA
    // -------------------------------------------------------------------------
    await t.test("O.5: Cross-tenant order: Alpha member cannot checkout on Beta", async () => {
      const { data: offB } = await supabase.from("agency_offerings").select("id").eq("agency_id", agencyIdB).single();

      const { data: crossCheckout } = await supabase.rpc("checkout_agency_offering", {
        p_agency_id: agencyIdB,
        p_membership_id: memberIdA, // Alpha member in Beta agency!
        p_offering_id: offB.id,
        p_bank_account_id: null,
        p_idempotency_order_code: `CROSS-${nonce}`
      });

      assert.equal(crossCheckout.ok, false);
      assert.equal(crossCheckout.code, "membership_not_found"); // Fails closed
    });

    // -------------------------------------------------------------------------
    // 6. CROSS-TENANT ENTITLEMENT: ALPHA GRANT DOES NOT GRANT BETA
    // -------------------------------------------------------------------------
    await t.test("O.6: Cross-tenant entitlement: Alpha grant does not grant Beta", async () => {
      // Find Alpha canonical course
      const { data: ccA } = await supabase.from("canonical_courses").select("id").eq("code", `CC-ALPHA-${nonce}`).single();
      const { data: ccB } = await supabase.from("canonical_courses").select("id").eq("code", `CC-BETA-${nonce}`).single();

      // Create an entitlement for memberIdA in Agency A
      const { data: entA } = await supabase.from("student_entitlements").insert({
        agency_id: agencyIdA,
        membership_id: memberIdA,
        canonical_course_id: ccA.id,
        status: "active"
      }).select("id").single();

      // Verify query on Beta agency returns 0 entitlements for memberIdA
      const { data: entBetaCheck } = await supabase
        .from("student_entitlements")
        .select("id")
        .eq("agency_id", agencyIdB)
        .eq("membership_id", memberIdA);

      assert.equal(entBetaCheck.length, 0);

      // Verify query on Beta course returns 0 entitlements
      const { data: entBetaCourseCheck } = await supabase
        .from("student_entitlements")
        .select("id")
        .eq("canonical_course_id", ccB.id)
        .eq("membership_id", memberIdA);

      assert.equal(entBetaCourseCheck.length, 0);
    });

    // -------------------------------------------------------------------------
    // 7. CROSS-TENANT PLAYBACK RPC: ALPHA MEMBER CANNOT PLAYBACK BETA LESSON
    // -------------------------------------------------------------------------
    await t.test("O.7: Cross-tenant playback RPC: Alpha member cannot playback Beta lesson", async () => {
      const dummyLessonId = crypto.randomUUID();
      const dummyAssetId = crypto.randomUUID();

      const { data: crossAuth } = await supabase.rpc("v5_authorize_agency_playback", {
        p_agency_id: agencyIdB,
        p_membership_id: memberIdA, // Alpha member in Beta agency
        p_lesson_id: dummyLessonId,
        p_asset_id: dummyAssetId
      });

      assert.equal(crossAuth.authorized, false);
      assert.ok(["agency_membership_not_found", "cross_agency_forbidden", "invalid_membership"].includes(crossAuth.code));
    });
  } finally {
    // -------------------------------------------------------------------------
    // 8. TEARDOWN BOTH TENANTS & FIXTURES WITH VERIFIED REHEARSAL RUN ID
    // -------------------------------------------------------------------------
    await t.test("O.8: Teardown both synthetic tenants completely", async () => {
      if (slugA) {
        await deprovisionAgency(slugA, { confirm: true, isTestTarget: true, rehearsalRunId });
      }
      if (slugB) {
        await deprovisionAgency(slugB, { confirm: true, isTestTarget: true, rehearsalRunId });
      }

      if (studentUserA) {
        try { await supabase.auth.admin.deleteUser(studentUserA); } catch (_) {}
      }

      // Clean up canonical courses created for test
      await supabase.from("canonical_courses").delete().in("code", [`CC-ALPHA-${nonce}`, `CC-BETA-${nonce}`]);

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
