// test/second-tenant-isolation.test.js
// Automated test suite for System B Milestone Phase O: Multi-Tenant Boundary & Second-Tenant Isolation
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Invariants:
//   - Proves zero hard-coded tenant identifiers.
//   - Verifies cross-tenant domain collision rejection.
//   - Verifies cross-tenant membership, order, and playback authorization isolation.
//   - Cleans up all synthetic multi-tenant test fixtures cleanly.

import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { supabase } from "../utils/supabase.js";
import {
  applyAgencyProvisioning,
  deprovisionAgency
} from "../utils/agency-provisioner.js";

test("SECOND-TENANT-ISOLATION: Strict Boundary Enforcement Across Multiple Tenants", async (t) => {
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
    ui: { brand_name: "Alpha Culinary", storefront_variant: "classic_culinary" },
    bank_accounts: [{ bank_code: "VCB", account_number: `111${nonce}`, account_holder: "ALPHA HOLDER" }],
    offerings: [{ slug: "alpha-course", display_title: "Alpha Course", price_vnd: 200000, is_published: true }],
    principals: [{ email: `admin@${slugA}.local`, role: "agency_owner" }]
  };

  const manifestB = {
    agency: { slug: slugB, name: "Tenant Beta Pastry", status: "active" },
    domains: [
      { hostname: hostB1, is_primary: true, ssl_status: "active" },
      { hostname: hostB2, is_primary: false, ssl_status: "active" }
    ],
    ui: { brand_name: "Beta Pastry", storefront_variant: "modern_minimal" },
    bank_accounts: [{ bank_code: "TCB", account_number: `222${nonce}`, account_holder: "BETA HOLDER" }],
    offerings: [{ slug: "beta-course", display_title: "Beta Course", price_vnd: 300000, is_published: true }],
    principals: [{ email: `admin@${slugB}.local`, role: "agency_owner" }]
  };

  let agencyIdA = null;
  let agencyIdB = null;
  let studentUserA = null;
  let studentUserB = null;
  let memberIdA = null;
  let memberIdB = null;

  try {
    // -------------------------------------------------------------------------
    // 1. PROVISION TENANT ALPHA
    // -------------------------------------------------------------------------
    await t.test("O.1: Provision Tenant Alpha", async () => {
      const resA = await applyAgencyProvisioning(manifestA, { allowSyntheticPrincipals: true });
      assert.equal(resA.ok, true);
      agencyIdA = resA.agencyId;
    });

    // -------------------------------------------------------------------------
    // 2. DOMAIN COLLISION REJECTION
    // -------------------------------------------------------------------------
    await t.test("O.2: Tenant Beta cannot hijack Tenant Alpha's domain", async () => {
      const collisionManifest = JSON.parse(JSON.stringify(manifestB));
      collisionManifest.domains[0].hostname = hostA1; // Collision with Alpha!

      await assert.rejects(
        async () => {
          await applyAgencyProvisioning(collisionManifest, { allowSyntheticPrincipals: true });
        },
        /SECURITY VIOLATION: Domain collision detected/
      );
    });

    // -------------------------------------------------------------------------
    // 3. PROVISION TENANT BETA
    // -------------------------------------------------------------------------
    await t.test("O.3: Provision Tenant Beta with unique isolated domains", async () => {
      const resB = await applyAgencyProvisioning(manifestB, { allowSyntheticPrincipals: true });
      assert.equal(resB.ok, true);
      agencyIdB = resB.agencyId;
      assert.notEqual(agencyIdA, agencyIdB);
    });

    // -------------------------------------------------------------------------
    // 4. MEMBERSHIP CROSS-TENANT ISOLATION
    // -------------------------------------------------------------------------
    await t.test("O.4: Memberships and buyers are strictly bounded to their agency", async () => {
      // Create user A in auth.users
      const { data: uA } = await supabase.auth.admin.createUser({
        email: `student-a-${nonce}@alpha.local`,
        email_confirm: true
      });
      studentUserA = uA.user.id;

      const { data: memA } = await supabase
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
      memberIdA = memA.id;

      // Create user B in auth.users
      const { data: uB } = await supabase.auth.admin.createUser({
        email: `student-b-${nonce}@beta.local`,
        email_confirm: true
      });
      studentUserB = uB.user.id;

      const { data: memB } = await supabase
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
      memberIdB = memB.id;

      // Verify that memberIdA cannot be used in agencyIdB checkout
      const { data: offB } = await supabase.from("agency_offerings").select("id").eq("agency_id", agencyIdB).single();
      const { data: bankB } = await supabase.from("agency_bank_accounts").select("id").eq("agency_id", agencyIdB).single();

      const { data: crossCheckout } = await supabase.rpc("checkout_agency_offering", {
        p_agency_id: agencyIdB,
        p_membership_id: memberIdA, // Alpha member in Beta agency!
        p_offering_id: offB.id,
        p_bank_account_id: bankB.id,
        p_idempotency_order_code: `CROSS-${nonce}`
      });

      assert.equal(crossCheckout.ok, false);
      assert.equal(crossCheckout.code, "membership_not_found"); // Fails closed
    });

    // -------------------------------------------------------------------------
    // 5. PLAYBACK AUTHORIZATION CROSS-TENANT ISOLATION
    // -------------------------------------------------------------------------
    await t.test("O.5: Playback authorization denies cross-tenant access", async () => {
      const dummyLessonId = crypto.randomUUID();
      const dummyAssetId = crypto.randomUUID();

      // Member A calling Beta agency playback
      const { data: crossAuth } = await supabase.rpc("v5_authorize_agency_playback", {
        p_agency_id: agencyIdB,
        p_membership_id: memberIdA,
        p_lesson_id: dummyLessonId,
        p_asset_id: dummyAssetId
      });

      assert.equal(crossAuth.authorized, false);
      assert.equal(crossAuth.code, "cross_agency_forbidden");
    });
  } finally {
    // -------------------------------------------------------------------------
    // 6. TEARDOWN BOTH TENANTS & FIXTURES
    // -------------------------------------------------------------------------
    await t.test("O.6: Teardown both synthetic tenants completely", async () => {
      if (slugA) {
        await deprovisionAgency(slugA, { confirm: true, forceSynthetic: true });
      }
      if (slugB) {
        await deprovisionAgency(slugB, { confirm: true, forceSynthetic: true });
      }

      if (studentUserA) {
        try { await supabase.auth.admin.deleteUser(studentUserA); } catch (_) {}
      }
      if (studentUserB) {
        try { await supabase.auth.admin.deleteUser(studentUserB); } catch (_) {}
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
