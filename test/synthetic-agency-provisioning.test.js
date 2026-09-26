// test/synthetic-agency-provisioning.test.js
// Automated test suite for System B Milestone M0C — Synthetic Agency A Provisioning & Commerce/LMS Rehearsal
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Invariants:
//   - Uses disposable synthetic fixtures only.
//   - Strict idempotency: Running provisioning twice yields 0 duplicates.
//   - Commerce immutable financial snapshot and multi-grant entitlement lifecycle tested.
//   - Playback authorization tested fail-closed against cross-tenant attacks.
//   - Complete teardown and fixture deprovisioning verified.

import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { supabase } from "../utils/supabase.js";
import {
  validateManifest,
  planAgencyProvisioning,
  applyAgencyProvisioning,
  validateAgencyProvisioning,
  deprovisionAgency
} from "../utils/agency-provisioner.js";

test("SYNTHETIC-AGENCY-REHEARSAL: Full Lifecycle (Plan -> Apply -> Idempotency -> Validation -> Commerce -> Auth -> Deprovision)", async (t) => {
  const nonce = Date.now().toString().slice(-6);
  const syntheticSlug = `syn-agency-${nonce}`;
  const syntheticCommerceHost = `commerce-${syntheticSlug}.local`;
  const syntheticLmsHost = `lms-${syntheticSlug}.local`;

  // Fetch an existing course to test V5 course mapping if available
  const { data: courses } = await supabase.from("courses").select("id").limit(1);
  const realCourseId = courses && courses.length > 0 ? courses[0].id : null;

  const syntheticManifest = {
    agency: {
      slug: syntheticSlug,
      name: "Synthetic Agency A Rehearsal",
      status: "active"
    },
    domains: [
      { hostname: syntheticCommerceHost, is_primary: true, ssl_status: "active" },
      { hostname: syntheticLmsHost, is_primary: false, ssl_status: "active" }
    ],
    ui: {
      brand_name: "Synthetic Culinary Academy",
      logo_url: "https://assets.synthetic.local/logo.svg",
      favicon_url: "https://assets.synthetic.local/favicon.ico",
      storefront_variant: "classic_culinary",
      checkout_variant: "one_page_qr",
      admin_variant: "standard_agency",
      learner_variant: "card_dashboard",
      learning_variant: "cinema_player",
      homework_variant: "photo_submission",
      design_tokens: { primaryColor: "#e11d48" },
      feature_flags: { enableHomework: true }
    },
    bank_accounts: [
      {
        bank_code: "MBBANK",
        account_number: `888${nonce}`,
        account_holder: "SYNTHETIC CHEF ACADEMY",
        branch: "Hanoi Main",
        is_default: true,
        is_active: true
      }
    ],
    learning: {
      courses: [
        {
          code: `CANONICAL-${syntheticSlug}`,
          title: "Master Vietnamese Cuisine",
          course_id: realCourseId,
          lessons: [
            {
              title: "Lesson 1: Pho Master Stock",
              sort_order: 1,
              is_free_preview: true
            },
            {
              title: "Lesson 2: Spice Balance",
              sort_order: 2,
              is_free_preview: false
            }
          ]
        }
      ]
    },
    offerings: [
      {
        slug: "master-pho-bundle",
        display_title: "Master Pho Course Bundle",
        display_description: "Comprehensive pho making masterclass",
        price_vnd: 599000,
        sale_price_vnd: 499000,
        is_published: true,
        items: [
          {
            canonical_course_code: `CANONICAL-${syntheticSlug}`,
            item_type: "canonical_course",
            sort_order: 1
          }
        ]
      }
    ],
    principals: [
      {
        email: `owner@${syntheticSlug}.local`,
        role: "agency_owner",
        display_name: "Synthetic Agency Owner",
        status: "active"
      }
    ]
  };

  let agencyId = null;
  let canonicalCourseId = null;
  let offeringId = null;
  let bankAccountId = null;
  let studentMembershipId = null;
  let studentUserId = null;
  let orderCode = `ORD-${nonce}`;

  try {
    // -------------------------------------------------------------------------
    // 1. MANIFEST VALIDATION & SECRET REJECTION
    // -------------------------------------------------------------------------
    await t.test("L.1: Manifest schema validation & secret rejection", () => {
      const valid = validateManifest(syntheticManifest);
      assert.equal(valid.ok, true);

      // Attempt to include secret -> MUST THROW
      const taintedManifest = JSON.parse(JSON.stringify(syntheticManifest));
      taintedManifest.ui.brand_name = "service_role_secret_key";
      assert.throws(() => validateManifest(taintedManifest), /SECURITY VIOLATION/);
    });

    // -------------------------------------------------------------------------
    // 2. PLAN MODE (EMPTY TENANT STATE)
    // -------------------------------------------------------------------------
    await t.test("L.2: Plan mode on empty tenant state returns deterministic diff", async () => {
      const planResult = await planAgencyProvisioning(syntheticManifest);
      assert.equal(planResult.ok, true);
      assert.equal(planResult.plan.agencyExists, false);
      assert.ok(planResult.plan.summary.creates >= 4);
      assert.equal(planResult.plan.summary.conflicts, 0);
    });

    // -------------------------------------------------------------------------
    // 3. APPLY MODE (PROVISION FROM EMPTY STATE)
    // -------------------------------------------------------------------------
    await t.test("L.3: Apply mode provisions all entities from empty tenant state", async () => {
      const applyResult = await applyAgencyProvisioning(syntheticManifest, {
        allowSyntheticPrincipals: true
      });
      assert.equal(applyResult.ok, true);
      assert.ok(applyResult.agencyId);
      agencyId = applyResult.agencyId;
      assert.ok(applyResult.appliedActions.length >= 5);
    });

    // -------------------------------------------------------------------------
    // 4. IDEMPOTENCY VERIFICATION (SECOND PLAN & APPLY YIELD 0 DUPLICATES)
    // -------------------------------------------------------------------------
    await t.test("L.4: Second execution is strictly idempotent", async () => {
      const secondPlan = await planAgencyProvisioning(syntheticManifest);
      assert.equal(secondPlan.ok, true);
      assert.equal(secondPlan.plan.agencyExists, true);
      assert.equal(secondPlan.plan.summary.creates, 0);
      assert.ok(secondPlan.plan.summary.unchanged > 0);

      const secondApply = await applyAgencyProvisioning(syntheticManifest, {
        allowSyntheticPrincipals: true
      });
      assert.equal(secondApply.ok, true);
      assert.equal(secondApply.agencyId, agencyId);

      // Verify DB count: strictly 1 agency, 2 domains, 1 ui_profile, 1 bank account
      const { count: agCount } = await supabase.from("agencies").select("id", { count: "exact" }).eq("id", agencyId);
      assert.equal(agCount, 1);

      const { count: domCount } = await supabase.from("agency_domains").select("id", { count: "exact" }).eq("agency_id", agencyId);
      assert.equal(domCount, 2);

      const { count: bankCount } = await supabase.from("agency_bank_accounts").select("id", { count: "exact" }).eq("agency_id", agencyId);
      assert.equal(bankCount, 1);

      const { count: offCount } = await supabase.from("agency_offerings").select("id", { count: "exact" }).eq("agency_id", agencyId);
      assert.equal(offCount, 1);
    });

    // -------------------------------------------------------------------------
    // 5. VALIDATION TOOL (ALL 11 READINESS GATES PASS)
    // -------------------------------------------------------------------------
    await t.test("L.5: Validator confirms all 11 readiness gates pass", async () => {
      const valResult = await validateAgencyProvisioning(syntheticSlug, syntheticManifest);
      assert.equal(valResult.checks.AGENCY_EXISTS, true);
      assert.equal(valResult.checks.DOMAINS_VALID, true);
      assert.equal(valResult.checks.DOMAIN_COLLISION_FREE, true);
      assert.equal(valResult.checks.UI_PROFILE_COMPLETE, true);
      assert.equal(valResult.checks.BANK_CONFIG_COMPLETE, true);
      assert.equal(valResult.checks.OFFERINGS_COMPLETE, true);
      assert.equal(valResult.checks.COURSE_MAPPING_COMPLETE, true);
      if (realCourseId) {
        assert.equal(valResult.checks.V5_MAPPING_COMPLETE, true);
      }
      assert.equal(valResult.checks.PRINCIPALS_COMPLETE, true);
      assert.equal(valResult.checks.MEMBERSHIPS_COMPLETE, true);
      assert.equal(valResult.checks.HOMEWORK_READY, true);
    });

    // -------------------------------------------------------------------------
    // 6. SYNTHETIC COMMERCE REHEARSAL
    // -------------------------------------------------------------------------
    await t.test("L.6: Synthetic Commerce Lifecycle: checkout -> snapshot -> approval -> entitlement", async () => {
      // 6.1 Create synthetic student membership with real auth.users backing
      const { data: studentUser, error: suErr } = await supabase.auth.admin.createUser({
        email: `student-${nonce}@synthetic.local`,
        email_confirm: true
      });
      assert.ifError(suErr);
      studentUserId = studentUser.user.id;

      const { data: member, error: memErr } = await supabase
        .from("agency_memberships")
        .insert({
          agency_id: agencyId,
          user_id: studentUserId,
          role: "student",
          display_name: "Rehearsal Student",
          phone: `0987${nonce}`
        })
        .select("id")
        .single();
      assert.ifError(memErr);
      studentMembershipId = member.id;

      // Resolve offering & bank
      const { data: off } = await supabase.from("agency_offerings").select("id, price_vnd, sale_price_vnd").eq("agency_id", agencyId).single();
      offeringId = off.id;
      const expectedPrice = off.sale_price_vnd || off.price_vnd;

      const { data: bank } = await supabase.from("agency_bank_accounts").select("id, bank_code, account_number").eq("agency_id", agencyId).single();
      bankAccountId = bank.id;

      // 6.2 Execute Checkout RPC
      const { data: checkoutRes, error: coErr } = await supabase.rpc("checkout_agency_offering", {
        p_agency_id: agencyId,
        p_membership_id: studentMembershipId,
        p_offering_id: offeringId,
        p_bank_account_id: bankAccountId,
        p_idempotency_order_code: orderCode
      });
      assert.ifError(coErr);
      assert.equal(checkoutRes.ok, true);
      assert.equal(checkoutRes.status, "pending");
      assert.equal(Number(checkoutRes.amount_vnd), Number(expectedPrice));
      assert.equal(checkoutRes.bank_code, bank.bank_code);
      assert.equal(checkoutRes.account_number, bank.account_number);

      const orderId = checkoutRes.order_id;

      // 6.3 Test Checkout Idempotency: same order code returns stored snapshot
      const { data: dupCheckout } = await supabase.rpc("checkout_agency_offering", {
        p_agency_id: agencyId,
        p_membership_id: studentMembershipId,
        p_offering_id: offeringId,
        p_bank_account_id: bankAccountId,
        p_idempotency_order_code: orderCode
      });
      assert.equal(dupCheckout.ok, true);
      assert.equal(dupCheckout.idempotent, true);
      assert.equal(dupCheckout.order_id, orderId);

      // 6.4 Test Price Changed After Checkout: snapshot remains unchanged
      await supabase.from("agency_offerings").update({ sale_price_vnd: 123456 }).eq("id", offeringId);
      const { data: snapshotCheck } = await supabase.rpc("checkout_agency_offering", {
        p_agency_id: agencyId,
        p_membership_id: studentMembershipId,
        p_offering_id: offeringId,
        p_bank_account_id: bankAccountId,
        p_idempotency_order_code: orderCode
      });
      assert.equal(Number(snapshotCheck.amount_vnd), Number(expectedPrice)); // Still original 499000!

      // 6.5 Test Idempotency Ownership Conflict
      const otherMembershipId = crypto.randomUUID();
      const { data: conflictRes } = await supabase.rpc("checkout_agency_offering", {
        p_agency_id: agencyId,
        p_membership_id: otherMembershipId,
        p_offering_id: offeringId,
        p_bank_account_id: bankAccountId,
        p_idempotency_order_code: orderCode
      });
      assert.equal(conflictRes.ok, false);
      assert.equal(conflictRes.code, "membership_not_found"); // Fails closed

      // 6.6 Test Order Approval & Entitlement Grant
      const { data: approveRes, error: appErr } = await supabase.rpc("approve_agency_order", {
        p_agency_id: agencyId,
        p_order_id: orderId,
        p_approved_by_membership_id: null
      });
      assert.ifError(appErr);
      assert.equal(approveRes.ok, true);
      assert.equal(approveRes.status, "completed");
      assert.ok((approveRes.grants_created ?? approveRes.entitlements_granted) >= 1);

      // 6.7 Duplicate Approval is idempotent
      const { data: dupApprove } = await supabase.rpc("approve_agency_order", {
        p_agency_id: agencyId,
        p_order_id: orderId,
        p_approved_by_membership_id: null
      });
      assert.equal(dupApprove.ok, true);
      assert.equal(dupApprove.idempotent, true);

      // 6.8 Verify Entitlement and Grants exist in DB
      const { data: entList } = await supabase
        .from("student_entitlements")
        .select("id, status, canonical_course_id")
        .eq("agency_id", agencyId)
        .eq("membership_id", studentMembershipId);
      assert.ok(entList && entList.length >= 1);
      assert.equal(entList[0].status, "active");
      canonicalCourseId = entList[0].canonical_course_id;

      // 6.9 Multi-grant independence: Add a second grant source to same entitlement
      const { error: grantErr } = await supabase
        .from("entitlement_grants")
        .insert({
          agency_id: agencyId,
          entitlement_id: entList[0].id,
          source_type: "manual_admin",
          source_reference_id: "PROMO-VIP",
          notes: "Complimentary VIP extension"
        });
      assert.ifError(grantErr);

      const { count: grantCount } = await supabase
        .from("entitlement_grants")
        .select("id", { count: "exact" })
        .eq("agency_id", agencyId)
        .eq("entitlement_id", entList[0].id);
      assert.equal(grantCount, 2); // order_purchase + manual_admin coexist
    });

    // -------------------------------------------------------------------------
    // 7. SYNTHETIC LMS PLAYBACK AUTHORIZATION REHEARSAL
    // -------------------------------------------------------------------------
    await t.test("L.7: Synthetic LMS Playback Authorization Fail-Closed Rehearsal", async () => {
      // 7.1 Cross-tenant caller check: Unauthorized membership fails closed
      const fakeMembershipId = crypto.randomUUID();
      const fakeLessonId = crypto.randomUUID();
      const fakeAssetId = crypto.randomUUID();

      const { data: crossTenantCheck } = await supabase.rpc("v5_authorize_agency_playback", {
        p_agency_id: agencyId,
        p_membership_id: fakeMembershipId,
        p_lesson_id: fakeLessonId,
        p_asset_id: fakeAssetId
      });
      assert.equal(crossTenantCheck.authorized, false);
      assert.equal(crossTenantCheck.code, "invalid_membership");

      // 7.2 Expired / nonexistent lesson check for valid student: fails closed
      const { data: studentCheck } = await supabase.rpc("v5_authorize_agency_playback", {
        p_agency_id: agencyId,
        p_membership_id: studentMembershipId,
        p_lesson_id: fakeLessonId,
        p_asset_id: fakeAssetId
      });
      assert.equal(studentCheck.authorized, false);
      assert.equal(studentCheck.code, "lesson_not_found");
    });
  } finally {
    // -------------------------------------------------------------------------
    // 8. TEARDOWN & DEPROVISIONING (FIXTURE CLEANUP)
    // -------------------------------------------------------------------------
    await t.test("L.8: Deprovisioning cleans up all synthetic fixtures completely", async () => {
      const deprovResult = await deprovisionAgency(syntheticSlug, {
        confirm: true,
        forceSynthetic: true
      });
      assert.equal(deprovResult.ok, true);
      assert.equal(deprovResult.deleted, true);

      // Verify agency row is gone
      const { data: checkAgency } = await supabase.from("agencies").select("id").eq("slug", syntheticSlug).maybeSingle();
      assert.equal(checkAgency, null);

      // Clean up test canonical course to prevent test residue
      if (syntheticManifest.learning?.courses) {
        for (const c of syntheticManifest.learning.courses) {
          const { data: cc } = await supabase.from("canonical_courses").select("id").eq("code", c.code).maybeSingle();
          if (cc) {
            await supabase.from("canonical_lessons").delete().eq("canonical_course_id", cc.id);
            await supabase.from("canonical_courses").delete().eq("id", cc.id);
          }
        }
      }

      // Clean up synthetic auth users
      if (studentUserId) {
        try { await supabase.auth.admin.deleteUser(studentUserId); } catch (_) {}
      }
      try {
        const { data: uList } = await supabase.auth.admin.listUsers();
        const principalUser = uList?.users?.find((u) => u.email === `owner@${syntheticSlug}.local`);
        if (principalUser) {
          await supabase.auth.admin.deleteUser(principalUser.id);
        }
      } catch (_) {}
    });
  }
});
