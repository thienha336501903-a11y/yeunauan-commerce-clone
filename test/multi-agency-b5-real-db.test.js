// test/multi-agency-b5-real-db.test.js
// Milestone B5 / M0B.1 Real Database Verification Suite
// Uses REAL PostgreSQL Database (Local Postgres 17.6) with REAL transactions and locks.

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import crypto from "node:crypto";

const DB_URL = process.env.LOCAL_TEST_DB_URL || "postgres://postgres:postgres@127.0.0.1:54332/postgres";
const pool = new pg.Pool({ connectionString: DB_URL });

function randId() {
  return crypto.randomUUID();
}

test("B5-REAL-DB: Complete Commerce, Snapshot, Concurrency, and Grant Lifecycle Suite", async (t) => {
  const agencyId = randId();
  const userIdA = randId();
  const userIdB = randId();
  const membershipIdA = randId();
  const membershipIdB = randId();
  const staffUserId = randId();
  const staffMembershipId = randId();
  const bankId = randId();
  const offeringId = randId();
  const courseId1 = randId();
  const courseId2 = randId();

  // Setup test fixture in local DB
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Create auth users
    const ts = Date.now();
    await client.query(
      "INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)",
      [userIdA, `userA-${ts}@test.local`, userIdB, `userB-${ts}@test.local`, staffUserId, `staff-${ts}@test.local`]
    );

    // 2. Create Agency
    await client.query(
      "INSERT INTO public.agencies (id, slug, name, status) VALUES ($1, $2, $3, 'active')",
      [agencyId, `agency-${Date.now()}`, "Test Culinary Agency"]
    );

    // 3. Create Memberships
    await client.query(
      `INSERT INTO public.agency_memberships (id, agency_id, user_id, role, status, display_name, phone)
       VALUES ($1, $2, $3, 'student', 'active', 'Student A', '0901234567'),
              ($4, $2, $5, 'student', 'active', 'Student B', '0907654321'),
              ($6, $2, $7, 'agency_staff', 'active', 'Staff Member', '0909999999')`,
      [membershipIdA, agencyId, userIdA, membershipIdB, userIdB, staffMembershipId, staffUserId]
    );

    // 4. Create Bank Account
    await client.query(
      `INSERT INTO public.agency_bank_accounts (id, agency_id, bank_code, account_number, account_holder, is_default, is_active)
       VALUES ($1, $2, 'VCB', '0123456789', 'CHEF ACADEMY', true, true)`,
      [bankId, agencyId]
    );

    // 5. Create Canonical Courses
    await client.query(
      `INSERT INTO public.canonical_courses (id, code, default_title, status)
       VALUES ($1, $2, 'Pho Bo Masterclass', 'published'),
              ($3, $4, 'Banh Mi Masterclass', 'published')`,
      [courseId1, `PHO-${Date.now()}`, courseId2, `BM-${Date.now()}`]
    );

    // 6. Create Offering bundling both courses
    await client.query(
      `INSERT INTO public.agency_offerings (id, agency_id, slug, display_title, price_vnd, sale_price_vnd, is_published)
       VALUES ($1, $2, 'combo-bep-viet', 'Combo Bep Viet', 500000, 450000, true)`,
      [offeringId, agencyId]
    );

    // 7. Add offering items
    await client.query(
      `INSERT INTO public.agency_offering_items (agency_id, offering_id, item_type, canonical_course_id, sort_order)
       VALUES ($1, $2, 'canonical_course', $3, 1),
              ($1, $2, 'canonical_course', $4, 2)`,
      [agencyId, offeringId, courseId1, courseId2]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    client.release();
    throw err;
  }
  client.release();

  // ---------------------------------------------------------------------------
  // TEST 1: Checkout Snapshot & Idempotent Retry
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-1: Checkout creates immutable snapshot and stores items", async () => {
    const orderCode = `ORD-${Date.now()}`;

    // Execute checkout RPC with auto-derived bank
    const checkoutRes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdA, offeringId, orderCode]
    );
    const data = checkoutRes.rows[0].result;
    assert.equal(data.ok, true);
    assert.equal(data.idempotent, false);
    assert.equal(data.amount_vnd, 450000);
    assert.equal(data.bank_code, "VCB");
    assert.equal(data.account_number, "0123456789");

    const orderId = data.order_id;

    // Verify order_items were snapshotted for both courses
    const itemsRes = await pool.query(
      `SELECT canonical_course_id, price_vnd FROM public.order_items WHERE agency_id = $1 AND order_id = $2 ORDER BY canonical_course_id ASC`,
      [agencyId, orderId]
    );
    assert.equal(itemsRes.rows.length, 2);
    const storedCourses = itemsRes.rows.map((r) => r.canonical_course_id).sort();
    assert.deepEqual(storedCourses, [courseId1, courseId2].sort());

    // Idempotent retry: Returns stored snapshot
    const retryRes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdA, offeringId, orderCode]
    );
    const retryData = retryRes.rows[0].result;
    assert.equal(retryData.ok, true);
    assert.equal(retryData.idempotent, true);
    assert.equal(retryData.order_id, orderId);
    assert.equal(retryData.amount_vnd, 450000);
  });

  // ---------------------------------------------------------------------------
  // TEST 2: Reused Code for Different Membership Fails Closed
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-2: Idempotency ownership conflict fails closed", async () => {
    const orderCode = `ORD-CONFLICT-${Date.now()}`;

    // Checkout for Member A
    await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdA, offeringId, orderCode]
    );

    // Attempt to reuse same code for Member B -> MUST FAIL with conflict
    const conflictRes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdB, offeringId, orderCode]
    );
    const conflictData = conflictRes.rows[0].result;
    assert.equal(conflictData.ok, false);
    assert.equal(conflictData.code, "idempotency_ownership_conflict");
  });

  // ---------------------------------------------------------------------------
  // TEST 3: Offering Changes Do Not Alter Stored Order or Granted Entitlements
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-3: Offering changes after checkout do not affect order", async () => {
    const orderCode = `ORD-OFFERING-CHANGE-${Date.now()}`;

    // 1. Checkout order at 450k VND bundling course 1 and 2
    const checkoutRes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdA, offeringId, orderCode]
    );
    const orderId = checkoutRes.rows[0].result.order_id;

    // 2. Mutate offering: Increase price to 990k VND, and remove Course 2 from bundle!
    await pool.query(
      `UPDATE public.agency_offerings SET price_vnd = 1200000, sale_price_vnd = 990000 WHERE id = $1`,
      [offeringId]
    );
    await pool.query(
      `DELETE FROM public.agency_offering_items WHERE agency_id = $1 AND offering_id = $2 AND canonical_course_id = $3`,
      [agencyId, offeringId, courseId2]
    );

    // 3. Retry checkout -> STILL returns original snapshot (450k VND)
    const retryRes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdA, offeringId, orderCode]
    );
    assert.equal(retryRes.rows[0].result.amount_vnd, 450000);

    // 4. Approve order -> MUST grant entitlements for BOTH Course 1 and Course 2 (from stored order_items!)
    const approveRes = await pool.query(
      `SELECT public.approve_agency_order($1, $2, $3) as result`,
      [agencyId, orderId, staffMembershipId]
    );
    assert.equal(approveRes.rows[0].result.ok, true);
    assert.equal(approveRes.rows[0].result.grants_created, 2);

    // Verify entitlements were granted for both courses
    const entRes = await pool.query(
      `SELECT canonical_course_id, status FROM public.student_entitlements WHERE agency_id = $1 AND membership_id = $2`,
      [agencyId, membershipIdA]
    );
    const activeCourses = entRes.rows.filter((r) => r.status === "active").map((r) => r.canonical_course_id);
    assert.ok(activeCourses.includes(courseId1));
    assert.ok(activeCourses.includes(courseId2));
  });

  // ---------------------------------------------------------------------------
  // TEST 4: Refund State Machine & Multi-Grant Coexistence
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-4: Refund state machine and multi-grant independence", async () => {
    const orderCode = `ORD-REFUND-TEST-${Date.now()}`;

    // 1. Checkout pending order
    const checkoutRes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdB, offeringId, orderCode]
    );
    const orderId = checkoutRes.rows[0].result.order_id;

    // 2. Attempt refund on pending order -> MUST FAIL (Refund only permitted for completed)
    const badRefund = await pool.query(
      `SELECT public.refund_agency_order($1, $2, 'Premature refund attempt') as result`,
      [agencyId, orderId]
    );
    assert.equal(badRefund.rows[0].result.ok, false);
    assert.equal(badRefund.rows[0].result.code, "invalid_order_status");

    // 3. Approve order -> status completed
    await pool.query(
      `SELECT public.approve_agency_order($1, $2, $3) as result`,
      [agencyId, orderId, staffMembershipId]
    );

    // 4. Add an independent admin grant for Course 1
    const entCourse1Res = await pool.query(
      `SELECT id FROM public.student_entitlements WHERE agency_id = $1 AND membership_id = $2 AND canonical_course_id = $3`,
      [agencyId, membershipIdB, courseId1]
    );
    const ent1Id = entCourse1Res.rows[0].id;

    await pool.query(
      `INSERT INTO public.entitlement_grants (agency_id, entitlement_id, source_type, source_reference_id, notes, status)
       VALUES ($1, $2, 'manual_admin', 'VIP-PROMO-123', 'VIP Award', 'active')`,
      [agencyId, ent1Id]
    );

    // 5. Refund the purchase order
    const refundRes = await pool.query(
      `SELECT public.refund_agency_order($1, $2, 'Customer requested refund') as result`,
      [agencyId, orderId]
    );
    assert.equal(refundRes.rows[0].result.ok, true);
    assert.equal(refundRes.rows[0].result.status, "refunded");

    // 6. Check effective entitlement status:
    // Course 1 STILL ACTIVE (due to VIP-PROMO-123 grant)
    const ent1Status = await pool.query(
      `SELECT status FROM public.student_entitlements WHERE id = $1`,
      [ent1Id]
    );
    assert.equal(ent1Status.rows[0].status, "active");

    // Idempotent duplicate refund
    const dupRefund = await pool.query(
      `SELECT public.refund_agency_order($1, $2, 'Duplicate refund') as result`,
      [agencyId, orderId]
    );
    assert.equal(dupRefund.rows[0].result.ok, true);
    assert.equal(dupRefund.rows[0].result.idempotent, true);
  });

  // ---------------------------------------------------------------------------
  // TEST 5: Concurrent Real Database Transactions (Deterministic Lock Order)
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-5: Concurrent approval transactions serialize without deadlock", async () => {
    // Create two separate orders for the same student
    const code1 = `CONC-ORD-1-${Date.now()}`;
    const code2 = `CONC-ORD-2-${Date.now()}`;

    const r1 = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdA, offeringId, code1]
    );
    const r2 = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdA, offeringId, code2]
    );

    const orderId1 = r1.rows[0].result.order_id;
    const orderId2 = r2.rows[0].result.order_id;

    // Launch concurrent approval transactions simultaneously
    const [approve1, approve2] = await Promise.all([
      pool.query(`SELECT public.approve_agency_order($1, $2, $3) as result`, [agencyId, orderId1, staffMembershipId]),
      pool.query(`SELECT public.approve_agency_order($1, $2, $3) as result`, [agencyId, orderId2, staffMembershipId])
    ]);

    assert.equal(approve1.rows[0].result.ok, true);
    assert.equal(approve2.rows[0].result.ok, true);
  });

  await pool.end();
});
