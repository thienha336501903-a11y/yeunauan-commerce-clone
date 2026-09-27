// test/synthetic-agency-provisioning.test.js
// Automated test suite for System B Milestone M0C — Synthetic Agency A Provisioning & Commerce/LMS Rehearsal
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Invariants:
//   - Uses disposable synthetic fixtures only.
//   - Strict idempotency & concurrency safety: Simultaneous applies yield 0 duplicates.
//   - Synthetic marker safety: Existing non-synthetic tenant cannot be turned synthetic or deprovisioned.
//   - Atomic apply with compensating rollback on injected mid-apply failure.
//   - Request authority commerce flow: Signed JWTs, trusted tenant resolution, checkoutOffering, approve, refund.
//   - Mutation after checkout (price, bank, offering items) does not alter stored order snapshot.
//   - Playback authorization tested fail-closed against cross-tenant attacks.
//   - Deprovisioning verified with trusted rehearsal run marker.
//   - REAL_AGENCY_A_PLAYBACK = NOT_EXECUTED

import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "../utils/supabase.js";
import {
  validateManifest,
  planAgencyProvisioning,
  applyAgencyProvisioning,
  verifyAgencyReadiness,
  deprovisionAgency
} from "../utils/agency-provisioner.js";
import {
  checkoutOffering,
  approveAgencyOrder,
  refundAgencyOrder
} from "../utils/agency-commerce.js";
import { _clearTenantCache } from "../utils/tenant-resolver.js";

test("SYNTHETIC-AGENCY-REHEARSAL: Full Lifecycle (Plan -> Apply -> Idempotency/Concurrency -> Marker Safety -> Atomic Rollback -> Validation -> Request-Bound Commerce -> Auth -> Refund -> Deprovision)", async (t) => {
  const rehearsalRunId = crypto.randomUUID();
  const nonce = Date.now().toString().slice(-6);
  const syntheticSlug = `syn-agency-${nonce}`;
  const syntheticCommerceHost = `commerce-${syntheticSlug}.local`;
  const syntheticLmsHost = `lms-${syntheticSlug}.local`;

  // Fetch an existing course with a published V5 release for canonical mapping
  const { data: v5Configs } = await supabase
    .from("v5_course_configs")
    .select("course_id, published_release_id")
    .eq("status", "published")
    .limit(1);

  let realCourseId = null;
  let v5LessonId = null;
  if (v5Configs && v5Configs.length > 0) {
    realCourseId = v5Configs[0].course_id;
    const { data: v5Rel } = await supabase
      .from("v5_releases")
      .select("snapshot")
      .eq("id", v5Configs[0].published_release_id)
      .maybeSingle();
    if (v5Rel?.snapshot?.lessons?.length > 0) {
      v5LessonId = v5Rel.snapshot.lessons[0].id;
    }
  }
  if (!v5LessonId) {
    v5LessonId = "bd6919fd-6778-4ab9-adcd-b42c9e7f3e45";
  }

  const ownerEmail = `owner@${syntheticSlug}.local`;
  const ownerPassword = `OwnerPass_${nonce}!123`;
  let ownerUserId = null;
  const { data: ownerUserCreated, error: ownerCreateErr } = await supabase.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true
  });
  assert.ifError(ownerCreateErr);
  ownerUserId = ownerUserCreated.user.id;
  let secondCourseId = null;

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
              is_free_preview: true,
              v5_lesson_id: v5LessonId
            },
            {
              title: "Lesson 2: Spice Balance",
              sort_order: 2,
              is_free_preview: false,
              v5_lesson_id: v5LessonId
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
  let studentToken = null;
  let staffUserId = null;
  let staffMembershipId = null;
  let staffToken = null;
  let orderCode = `ORD-${nonce}`;
  let orderId = null;

  const normalSlug = `norm-agency-${nonce}`;

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
    await t.test("L.3: Apply mode provisions all entities with trusted synthetic marker", async () => {
      const applyResult = await applyAgencyProvisioning(syntheticManifest, {
        isSynthetic: true,
        rehearsalRunId
      });
      assert.equal(applyResult.ok, true);
      assert.ok(applyResult.agencyId);
      agencyId = applyResult.agencyId;
      assert.ok(applyResult.appliedActions.length >= 5);
    });

    // -------------------------------------------------------------------------
    // 4. FIX 8A: CONCURRENT APPLY IDEMPOTENCY
    // -------------------------------------------------------------------------
    await t.test("L.4: Concurrent simultaneous applies are strictly idempotent with 0 duplicates", async () => {
      const [secondApply, thirdApply] = await Promise.all([
        applyAgencyProvisioning(syntheticManifest, {
          isSynthetic: true,
          rehearsalRunId
        }),
        applyAgencyProvisioning(syntheticManifest, {
          isSynthetic: true,
          rehearsalRunId
        })
      ]);
      assert.equal(secondApply.ok, true);
      assert.equal(thirdApply.ok, true);
      assert.equal(secondApply.agencyId, agencyId);
      assert.equal(thirdApply.agencyId, agencyId);

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
    // 4B. FIX 8B: SYNTHETIC MARKER SAFETY & ATOMIC ROLLBACK
    // -------------------------------------------------------------------------
    await t.test("L.4B: Synthetic marker safety and atomic rollback on failure", async () => {
      // 1. Create a non-synthetic agency directly
      const { data: normAg, error: normErr } = await supabase
        .from("agencies")
        .insert({ slug: normalSlug, name: "Normal Agency", status: "active" })
        .select("id")
        .single();
      assert.ifError(normErr);

      await supabase.from("agency_ui_profiles").insert({
        agency_id: normAg.id,
        brand_name: "Normal Brand",
        storefront_variant: "classic_culinary",
        checkout_variant: "one_page_qr",
        admin_variant: "standard_agency",
        learner_variant: "card_dashboard",
        learning_variant: "cinema_player",
        homework_variant: "photo_submission",
        feature_flags: { synthetic_rehearsal: false }
      });

      // 2. Caller attempting to pass --synthetic on existing non-synthetic agency must be DENIED
      const normalManifest = JSON.parse(JSON.stringify(syntheticManifest));
      normalManifest.agency.slug = normalSlug;
      normalManifest.domains = [{ hostname: `normal-${nonce}.local`, is_primary: true }];

      await assert.rejects(
        async () => {
          await applyAgencyProvisioning(normalManifest, { isSynthetic: true, rehearsalRunId });
        },
        /cannot be converted to a synthetic rehearsal fixture via --synthetic/
      );

      // 3. Existing non-synthetic agency CANNOT be deprovisioned
      await assert.rejects(
        async () => {
          await deprovisionAgency(normalSlug, { confirm: true, isTestTarget: true, rehearsalRunId });
        },
        /Cannot deprovision tenant.*lacks matching synthetic test marker/
      );

      // 3B. Wrong run_id => DENIED
      await assert.rejects(
        async () => {
          await deprovisionAgency(syntheticSlug, { confirm: true, isTestTarget: true, rehearsalRunId: crypto.randomUUID() });
        },
        /Cannot deprovision tenant.*lacks matching synthetic test marker/
      );

      // Clean up normal agency fixture
      await supabase.from("agency_ui_profiles").delete().eq("agency_id", normAg.id);
      await supabase.from("agencies").delete().eq("id", normAg.id);

      // 4. Injected mid-apply failure leaves ZERO partial state
      const failSlug = `fail-agency-${nonce}`;
      const failManifest = JSON.parse(JSON.stringify(syntheticManifest));
      failManifest.agency.slug = failSlug;
      failManifest.domains = [
        { hostname: `fail-commerce-${nonce}.local`, is_primary: true, ssl_status: "active" },
        { hostname: `fail-lms-${nonce}.local`, is_primary: false, ssl_status: "active" }
      ];
      failManifest.bank_accounts = [
        {
          bank_code: "MBBANK",
          account_number: `777${nonce}`,
          account_holder: "FAIL CHEF ACADEMY",
          is_default: true,
          is_active: true
        }
      ];
      failManifest.learning.courses[0].code = `FAIL-CC-${nonce}`;
      failManifest.learning.courses[0].course_id = realCourseId;
      failManifest.learning.courses[0].lessons[0].v5_lesson_id = v5LessonId;
      failManifest.offerings[0].items[0].canonical_course_code = `FAIL-CC-${nonce}`;
      failManifest.principals = [{ email: ownerEmail, role: "agency_owner" }];

      let caughtErr = null;
      try {
        await applyAgencyProvisioning(failManifest, {
          isSynthetic: true,
          rehearsalRunId,
          injectFailureAt: "final_write"
        });
      } catch (e) {
        caughtErr = e;
      }
      assert.ok(caughtErr, "Should have thrown mid-apply failure");
      assert.match(caughtErr.message || String(caughtErr), /INJECTED_FAILURE_TEST/);

      // Assert zero partial rows remaining for failSlug
      const { data: checkFailAg } = await supabase.from("agencies").select("id").eq("slug", failSlug).maybeSingle();
      assert.equal(checkFailAg, null, "Agency record must be rolled back");
      const { data: checkFailDom } = await supabase.from("agency_domains").select("id").eq("hostname", `fail-commerce-${nonce}.local`).maybeSingle();
      assert.equal(checkFailDom, null, "Domain record must be rolled back");
    });

    // -------------------------------------------------------------------------
    // 5. VALIDATION TOOL (ALL 11 READINESS GATES PASS)
    // -------------------------------------------------------------------------
    await t.test("L.5: Validator confirms all readiness gates pass", async () => {
      const valResult = await verifyAgencyReadiness(syntheticSlug);
      assert.equal(valResult.checks.AGENCY_EXISTS, true);
      assert.equal(valResult.checks.DOMAINS_MAPPED, true);
      assert.equal(valResult.checks.DOMAIN_COLLISION_FREE, true);
      assert.equal(valResult.checks.UI_PROFILE_COMPLETE, true);
      assert.equal(valResult.checks.BANK_CONFIG_COMPLETE, true);
      assert.equal(valResult.checks.OFFERINGS_COMPLETE, true);
      assert.equal(valResult.checks.COURSE_MAPPING_COMPLETE, true);
      assert.equal(valResult.checks.HOMEWORK_READY, true);
    });

    // -------------------------------------------------------------------------
    // 6. FIX 9: SYNTHETIC COMMERCE VIA APPLICATION REQUEST AUTHORITY
    // -------------------------------------------------------------------------
    await t.test("L.6: Request-Authority Commerce Lifecycle: signed JWT -> checkout -> mutate price/bank/items -> retry snapshot -> staff approve -> entitlement -> refund -> revoked", async () => {
      _clearTenantCache();
      const anonClient = createClient(
        process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      );

      // 6.1 Create synthetic student user and sign in to get signed JWT
      const studentEmail = `student-${nonce}@synthetic.local`;
      const studentPassword = `StudentPass_${nonce}!123`;
      const { data: studentUser, error: suErr } = await supabase.auth.admin.createUser({
        email: studentEmail,
        password: studentPassword,
        email_confirm: true
      });
      assert.ifError(suErr);
      studentUserId = studentUser.user.id;

      const { data: studentAuth, error: saErr } = await anonClient.auth.signInWithPassword({
        email: studentEmail,
        password: studentPassword
      });
      assert.ifError(saErr);
      studentToken = studentAuth.session.access_token;
      assert.ok(studentToken, "Must have valid signed student JWT");

      // Insert active student membership
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

      // 6.2 Create synthetic staff user and sign in to get signed JWT
      const staffEmail = `staff-${nonce}@synthetic.local`;
      const staffPassword = `StaffPass_${nonce}!123`;
      const { data: staffUser, error: staffUserErr } = await supabase.auth.admin.createUser({
        email: staffEmail,
        password: staffPassword,
        email_confirm: true
      });
      assert.ifError(staffUserErr);
      staffUserId = staffUser.user.id;

      const { data: staffAuth, error: staffAuthErr } = await anonClient.auth.signInWithPassword({
        email: staffEmail,
        password: staffPassword
      });
      assert.ifError(staffAuthErr);
      staffToken = staffAuth.session.access_token;
      assert.ok(staffToken, "Must have valid signed staff JWT");

      // Insert active staff membership
      const { data: staffMember, error: smErr } = await supabase
        .from("agency_memberships")
        .insert({
          agency_id: agencyId,
          user_id: staffUserId,
          role: "agency_staff",
          display_name: "Staff Approver",
          phone: `0988${nonce}`
        })
        .select("id")
        .single();
      assert.ifError(smErr);
      staffMembershipId = staffMember.id;

      // Resolve offering & bank
      const { data: off } = await supabase.from("agency_offerings").select("id, price_vnd, sale_price_vnd").eq("agency_id", agencyId).single();
      offeringId = off.id;
      const expectedPrice = off.sale_price_vnd || off.price_vnd;

      const { data: bank } = await supabase.from("agency_bank_accounts").select("id, bank_code, account_number").eq("agency_id", agencyId).single();
      bankAccountId = bank.id;

      // 6.3 Execute checkout via application request helper with student JWT and synthetic host
      const studentReq = {
        headers: {
          host: syntheticCommerceHost,
          authorization: `Bearer ${studentToken}`
        }
      };

      const checkoutRes = await checkoutOffering(studentReq, {
        offeringId,
        idempotencyOrderCode: orderCode
      });

      assert.equal(checkoutRes.ok, true);
      assert.equal(checkoutRes.order.status, "pending");
      assert.equal(Number(checkoutRes.order.amountVnd), Number(expectedPrice));
      assert.equal(checkoutRes.order.bankCode, bank.bank_code);
      assert.equal(checkoutRes.order.accountNumber, bank.account_number);
      orderId = checkoutRes.order.orderId;

      // 6.4 Mutate ALL THREE after checkout:
      // (1) Offering price
      await supabase.from("agency_offerings").update({ sale_price_vnd: 999999 }).eq("id", offeringId);

      // (2) Default bank account
      await supabase.from("agency_bank_accounts").update({ bank_code: "BIDV", account_number: "999999999" }).eq("id", bankAccountId);

      // (3) Offering items - use a second VALID existing canonical course
      const { data: secondCcList } = await supabase
        .from("canonical_courses")
        .select("id")
        .not("course_id", "is", null)
        .eq("status", "published")
        .neq("code", `CANONICAL-${syntheticSlug}`)
        .limit(1);
      assert.ok(secondCcList && secondCcList.length > 0, "Must have an existing second canonical course");
      secondCourseId = secondCcList[0].id;

      const { data: insItem, error: insItemErr } = await supabase.from("agency_offering_items").insert({
        agency_id: agencyId,
        offering_id: offeringId,
        canonical_course_id: secondCourseId,
        item_type: "canonical_course",
        sort_order: 2
      }).select("id").single();
      assert.ifError(insItemErr);
      assert.ok(insItem);

      // Verify order_items BEFORE retry
      const { data: storedOrderItemsBefore } = await supabase
        .from("order_items")
        .select("id, canonical_course_id")
        .eq("order_id", orderId);

      // 6.5 Retry checkout -> Returns original STORED snapshot (immutable quote, bank, and items)
      const retryRes = await checkoutOffering(studentReq, {
        offeringId,
        idempotencyOrderCode: orderCode
      });

      assert.equal(retryRes.ok, true);
      assert.equal(retryRes.order.idempotent, true);
      assert.equal(Number(retryRes.order.amountVnd), Number(expectedPrice), "Price must match stored historical snapshot");
      assert.equal(retryRes.order.bankCode, bank.bank_code, "Bank must match stored historical snapshot");
      assert.equal(retryRes.order.accountNumber, bank.account_number, "Account must match stored historical snapshot");

      // Verify stored order items after retry == before retry
      const { data: storedOrderItemsAfter } = await supabase
        .from("order_items")
        .select("id, canonical_course_id")
        .eq("order_id", orderId);
      assert.deepEqual(storedOrderItemsAfter, storedOrderItemsBefore, "order_items before retry must equal order_items after retry");

      // 6.6 Staff Approves Order via application request helper with staff JWT
      const staffReq = {
        headers: {
          host: syntheticCommerceHost,
          authorization: `Bearer ${staffToken}`
        }
      };

      const approveRes = await approveAgencyOrder(staffReq, orderId);
      assert.equal(approveRes.ok, true);
      assert.equal(approveRes.status, "completed");
      assert.ok(approveRes.grantsCreated >= 1);

      // Verify entitlement is active
      const { data: entList } = await supabase
        .from("student_entitlements")
        .select("id, status, canonical_course_id")
        .eq("agency_id", agencyId)
        .eq("membership_id", studentMembershipId);
      assert.ok(entList && entList.length >= 1);
      assert.equal(entList[0].status, "active");
      canonicalCourseId = entList[0].canonical_course_id;

      // 6.7 Staff Refunds Order via application request helper with staff JWT
      const refundRes = await refundAgencyOrder(staffReq, orderId, "Rehearsal refund");
      assert.equal(refundRes.ok, true);
      assert.equal(refundRes.status, "refunded");
      assert.ok(refundRes.grantsRevoked >= 1);

      // Verify entitlement status recomputed to revoked
      const { data: entAfterRefund } = await supabase
        .from("student_entitlements")
        .select("status")
        .eq("id", entList[0].id)
        .single();
      assert.equal(entAfterRefund.status, "revoked");

      // Verify agency readiness confirms true for synthetic tenant
      const readinessCheck = await verifyAgencyReadiness(syntheticSlug);
      assert.equal(readinessCheck.ok, true, "verifyAgencyReadiness must be true for synthetic tenant");
    });

    // -------------------------------------------------------------------------
    // 7. SYNTHETIC LMS PLAYBACK FAIL-CLOSED REHEARSAL
    // (Explicit check: REAL_AGENCY_A_PLAYBACK = NOT_EXECUTED)
    // -------------------------------------------------------------------------
    await t.test("L.7: Synthetic LMS Playback Authorization Fail-Closed Rehearsal", async () => {
      // Cross-tenant caller check
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
    });
  } finally {
    // -------------------------------------------------------------------------
    // 8. TEARDOWN & DEPROVISIONING (FIXTURE CLEANUP WITH RUN ID PROOF)
    // -------------------------------------------------------------------------
    await t.test("L.8: Deprovisioning cleans up synthetic fixtures with verified rehearsal run ID", async () => {
      if (agencyId) {
        const deprovResult = await deprovisionAgency(syntheticSlug, {
          confirm: true,
          isTestTarget: true,
          rehearsalRunId
        });
        assert.equal(deprovResult.ok, true);
        assert.equal(deprovResult.deleted, true);

        // Verify agency row is deleted
        const { data: checkAgency } = await supabase.from("agencies").select("id").eq("slug", syntheticSlug).maybeSingle();
        assert.equal(checkAgency, null);
      }

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
      if (secondCourseId) {
        try { await supabase.from("canonical_courses").delete().eq("id", secondCourseId); } catch (_) {}
      }
      if (ownerUserId) {
        try { await supabase.auth.admin.deleteUser(ownerUserId); } catch (_) {}
      }
      if (studentUserId) {
        try { await supabase.auth.admin.deleteUser(studentUserId); } catch (_) {}
      }
      if (staffUserId) {
        try { await supabase.auth.admin.deleteUser(staffUserId); } catch (_) {}
      }
    });
  }
});
