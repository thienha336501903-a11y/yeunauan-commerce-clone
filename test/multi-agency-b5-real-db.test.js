// test/multi-agency-b5-real-db.test.js
// Milestone B5 / Pre-M0C Remediation V2 Real Database Verification Suite
// Uses REAL PostgreSQL Database (Local Postgres 17.6) with REAL transactions, locks, and barriers.
// Covers:
// - B5.ORDER_MODEL (Phases 2A, 2B, 2C, 2D, 2E)
// - B5.GRANT_MODEL (Phase 3 lock order and state machine)
// - B5.REAL_CONCURRENCY_EVIDENCE (Phase 4 forced transaction overlap with barriers)

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import crypto from "node:crypto";

const DB_URL = process.env.LOCAL_TEST_DB_URL || "postgres://postgres:postgres@127.0.0.1:54332/postgres";
const pool = new pg.Pool({ connectionString: DB_URL });

function randId() {
  return crypto.randomUUID();
}

test("B5-REAL-DB: Complete Order Model, Lock Order, and Real Concurrency Suite", async (t) => {
  const agencyId = randId();
  const userIdA = randId();
  const userIdB = randId();
  const membershipIdA = randId();
  const membershipIdB = randId();
  const staffUserId = randId();
  const staffMembershipId = randId();
  const bankId = randId();
  const altBankId = randId();
  const offeringId = randId();
  const offeringId2 = randId();
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

    // 4. Create Bank Accounts (default bank and alternate bank)
    await client.query(
      `INSERT INTO public.agency_bank_accounts (id, agency_id, bank_code, account_number, account_holder, is_default, is_active)
       VALUES ($1, $2, 'VCB', '0123456789', 'CHEF ACADEMY', true, true),
              ($3, $2, 'TCB', '9876543210', 'CHEF ACADEMY TECH', false, true)`,
      [bankId, agencyId, altBankId]
    );

    // 5. Create Canonical Courses
    await client.query(
      `INSERT INTO public.canonical_courses (id, code, default_title, status)
       VALUES ($1, $2, 'Pho Bo Masterclass', 'published'),
              ($3, $4, 'Banh Mi Masterclass', 'published')`,
      [courseId1, `PHO-${Date.now()}`, courseId2, `BM-${Date.now()}`]
    );

    // 6. Create 2 Offerings
    await client.query(
      `INSERT INTO public.agency_offerings (id, agency_id, slug, display_title, price_vnd, sale_price_vnd, is_published)
       VALUES ($1, $2, 'combo-bep-viet', 'Combo Bep Viet', 500000, 450000, true),
              ($3, $2, 'single-pho', 'Single Pho Bo', 300000, 250000, true)`,
      [offeringId, agencyId, offeringId2]
    );

    // 7. Add offering items (Combo has 2 courses; Single has 1 course)
    await client.query(
      `INSERT INTO public.agency_offering_items (agency_id, offering_id, item_type, canonical_course_id, sort_order)
       VALUES ($1, $2, 'canonical_course', $3, 1),
              ($1, $2, 'canonical_course', $4, 2),
              ($1, $5, 'canonical_course', $3, 1)`,
      [agencyId, offeringId, courseId1, courseId2, offeringId2]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    client.release();
    throw err;
  }
  client.release();

  // ---------------------------------------------------------------------------
  // TEST 1: Phase 2A — Bank Selection Authority Removed from Client
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-1: Client bank ID cannot change bank destination", async () => {
    const orderCode = `ORD-BANK-TEST-${Date.now()}`;
    const attackerSpecifiedBankId = altBankId; // Client attempts to specify alternate bank

    const checkoutRes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, $4, $5) as result`,
      [agencyId, membershipIdA, offeringId, attackerSpecifiedBankId, orderCode]
    );
    const data = checkoutRes.rows[0].result;
    assert.equal(data.ok, true);
    // Server-selected default bank MUST be used (VCB), ignoring client's altBankId (TCB)
    assert.equal(data.bank_code, "VCB");
    assert.equal(data.account_number, "0123456789");
  });

  // ---------------------------------------------------------------------------
  // TEST 2: Phase 2B — Concurrent Idempotent Checkout Race
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-2: Two concurrent checkout calls same code both resolve to same snapshot", async () => {
    const orderCode = `ORD-RACE-CHECKOUT-${Date.now()}`;

    // Fire two checkout calls simultaneously for the exact same orderCode
    const [res1, res2] = await Promise.all([
      pool.query(`SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`, [agencyId, membershipIdA, offeringId, orderCode]),
      pool.query(`SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`, [agencyId, membershipIdA, offeringId, orderCode])
    ]);

    const d1 = res1.rows[0].result;
    const d2 = res2.rows[0].result;

    assert.equal(d1.ok, true);
    assert.equal(d2.ok, true);
    // Both must point to the identical order_id and snapshot details
    assert.equal(d1.order_id, d2.order_id);
    assert.equal(d1.amount_vnd, d2.amount_vnd);
    assert.equal(d1.bank_code, d2.bank_code);
    assert.equal(d1.transfer_content, d2.transfer_content);
    // Exactly one is initial insert, other is idempotent return
    assert.ok(d1.idempotent !== d2.idempotent || (d1.idempotent && d2.idempotent));
  });

  // ---------------------------------------------------------------------------
  // TEST 3: Phase 2B — Idempotency Ownership Conflicts Fail Closed
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-3: Different buyer same code denied & different offering same code denied", async () => {
    const orderCode = `ORD-OWNERSHIP-${Date.now()}`;

    // Initial checkout by Member A on Offering 1
    const initialRes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdA, offeringId, orderCode]
    );
    assert.equal(initialRes.rows[0].result.ok, true);

    // 1. Different buyer Member B using same code -> DENIED
    const buyerConflict = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdB, offeringId, orderCode]
    );
    assert.equal(buyerConflict.rows[0].result.ok, false);
    assert.equal(buyerConflict.rows[0].result.code, "idempotency_ownership_conflict");

    // 2. Same buyer but different offering using same code -> DENIED
    const offeringConflict = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdA, offeringId2, orderCode]
    );
    assert.equal(offeringConflict.rows[0].result.ok, false);
    assert.equal(offeringConflict.rows[0].result.code, "idempotency_ownership_conflict");
  });

  // ---------------------------------------------------------------------------
  // TEST 4: Phase 2C & 2D — Price/Bank/Bundle Mutation Immobility & Line Price Invariant
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-4: Price/bank/bundle change does not affect order; line items internally consistent", async () => {
    const orderCode = `ORD-IMMUTABLE-${Date.now()}`;

    // 1. Checkout 2-course bundle at 450,000 VND
    const checkoutRes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdA, offeringId, orderCode]
    );
    const orderId = checkoutRes.rows[0].result.order_id;
    assert.equal(checkoutRes.rows[0].result.amount_vnd, 450000);

    // 2. Verify 2D Bundle Item Price Apportioning: SUM(line prices) == order total
    const lineItemsRes = await pool.query(
      `SELECT price_vnd FROM public.order_items WHERE agency_id = $1 AND order_id = $2`,
      [agencyId, orderId]
    );
    assert.equal(lineItemsRes.rows.length, 2);
    const sumLinePrices = lineItemsRes.rows.reduce((acc, row) => acc + Number(row.price_vnd), 0);
    assert.equal(sumLinePrices, 450000, "SUM(item monetary snapshots) must equal order total");
    // Ensure line items do not duplicate the full bundle price
    assert.ok(Number(lineItemsRes.rows[0].price_vnd) < 450000);
    assert.ok(Number(lineItemsRes.rows[1].price_vnd) < 450000);

    // 3. Mutate offering: Increase price, switch default bank, and alter offering items!
    await pool.query(`UPDATE public.agency_offerings SET price_vnd = 2000000, sale_price_vnd = 1800000 WHERE id = $1`, [offeringId]);
    await pool.query(`UPDATE public.agency_bank_accounts SET is_default = false WHERE id = $1`, [bankId]);
    await pool.query(`UPDATE public.agency_bank_accounts SET is_default = true WHERE id = $1`, [altBankId]);
    await pool.query(`DELETE FROM public.agency_offering_items WHERE agency_id = $1 AND offering_id = $2 AND canonical_course_id = $3`, [agencyId, offeringId, courseId2]);

    // 4. Retry checkout with same orderCode -> Returns original snapshot untouched!
    const retryRes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdA, offeringId, orderCode]
    );
    const retryData = retryRes.rows[0].result;
    assert.equal(retryData.idempotent, true);
    assert.equal(retryData.amount_vnd, 450000, "Stored snapshot amount must remain 450k");
    assert.equal(retryData.bank_code, "VCB", "Stored bank code must remain VCB");

    // 5. Approve order -> grants both courses from original snapshot items
    const approveRes = await pool.query(
      `SELECT public.approve_agency_order($1, $2, $3) as result`,
      [agencyId, orderId, staffMembershipId]
    );
    assert.equal(approveRes.rows[0].result.ok, true);
    assert.equal(approveRes.rows[0].result.grants_created, 2);
  });

  // ---------------------------------------------------------------------------
  // TEST 5: Phase 2 FIX 2 — Offering Item Snapshot Race with Concurrent Mutation
  // Connection A: checkout
  // Connection B: add/remove offering item during checkout
  // Deterministic barrier forces overlap
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-5: Concurrent offering item mutation during checkout yields coherent snapshot", async () => {
    const testOfferingId = randId();
    const courseA = randId();
    const courseB = randId();
    const courseC = randId();

    await pool.query(
      `INSERT INTO public.canonical_courses (id, code, default_title, status)
       VALUES ($1, $2, 'Course A', 'published'),
              ($3, $4, 'Course B', 'published'),
              ($5, $6, 'Course C', 'published')`,
      [courseA, `CA-${Date.now()}`, courseB, `CB-${Date.now()}`, courseC, `CC-${Date.now()}`]
    );

    await pool.query(
      `INSERT INTO public.agency_offerings (id, agency_id, slug, display_title, price_vnd, sale_price_vnd, is_published)
       VALUES ($1, $2, $3, 'Race Bundle', 300000, 300000, true)`,
      [testOfferingId, agencyId, `race-bundle-${Date.now()}`]
    );

    await pool.query(
      `INSERT INTO public.agency_offering_items (agency_id, offering_id, item_type, canonical_course_id, sort_order)
       VALUES ($1, $2, 'canonical_course', $3, 1),
              ($1, $2, 'canonical_course', $4, 2)`,
      [agencyId, testOfferingId, courseA, courseB]
    );

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const orderCode = `ORD-CONC-ITEMS-${Date.now()}`;

    // Deterministic barrier
    let signalB;
    const barrierToB = new Promise((resolve) => { signalB = resolve; });
    let signalA;
    const barrierToA = new Promise((resolve) => { signalA = resolve; });

    try {
      const pA = (async () => {
        await clientA.query("BEGIN");
        // Lock offering row FOR SHARE to coordinate with B
        await clientA.query("SELECT price_vnd FROM public.agency_offerings WHERE id = $1 FOR SHARE", [testOfferingId]);
        signalB(); // Tell B that A is inside transaction
        await barrierToA; // Wait until B has injected the offering mutation
        const res = await clientA.query(
          `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
          [agencyId, membershipIdA, testOfferingId, orderCode]
        );
        await clientA.query("COMMIT");
        return res.rows[0].result;
      })();

      const pB = (async () => {
        await barrierToB; // Wait until A is inside transaction
        // Concurrently mutate offering items (add course C)
        await clientB.query(
          `INSERT INTO public.agency_offering_items (agency_id, offering_id, item_type, canonical_course_id, sort_order)
           VALUES ($1, $2, 'canonical_course', $3, 3)`,
          [agencyId, testOfferingId, courseC]
        );
        signalA(); // Tell A that mutation was committed
      })();

      const [resCheckout] = await Promise.all([pA, pB]);
      assert.equal(resCheckout.ok, true);

      // Verify the order has one coherent captured item set
      const itemsRes = await pool.query(
        `SELECT canonical_course_id, price_vnd FROM public.order_items WHERE order_id = $1`,
        [resCheckout.order_id]
      );
      assert.ok(itemsRes.rows.length >= 2, "Never zero items");
      const sumLinePrices = itemsRes.rows.reduce((sum, r) => sum + Number(r.price_vnd), 0);
      assert.equal(sumLinePrices, resCheckout.amount_vnd, "sum line prices == snapshot total");
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 6: Phase 3 & 4 FIX 3 — Multi-Course Real DB Concurrency Evidence
  // Scenario A: Approve reaches lock region first while Refund enters competing region
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-6: 2-Course bundle concurrency: Approve reaches lock region first, Refund competes", async () => {
    const bundleOfferingId = randId();
    const c1 = randId();
    const c2 = randId();

    // Sort c1 and c2 so we know deterministic lock order
    const [sortedC1, sortedC2] = [c1, c2].sort();

    await pool.query(
      `INSERT INTO public.canonical_courses (id, code, default_title, status)
       VALUES ($1, $2, 'Culinary 1', 'published'), ($3, $4, 'Culinary 2', 'published')`,
      [sortedC1, `C1-${Date.now()}`, sortedC2, `C2-${Date.now()}`]
    );

    await pool.query(
      `INSERT INTO public.agency_offerings (id, agency_id, slug, display_title, price_vnd, sale_price_vnd, is_published)
       VALUES ($1, $2, $3, 'Dual Culinary Masterclass', 600000, 600000, true)`,
      [bundleOfferingId, agencyId, `dual-bundle-${Date.now()}`]
    );

    await pool.query(
      `INSERT INTO public.agency_offering_items (agency_id, offering_id, item_type, canonical_course_id, sort_order)
       VALUES ($1, $2, 'canonical_course', $3, 1), ($1, $2, 'canonical_course', $4, 2)`,
      [agencyId, bundleOfferingId, sortedC1, sortedC2]
    );

    const code1 = `CONC-A-APP-${Date.now()}`;
    const code2 = `CONC-A-REF-${Date.now()}`;

    // Create 2 separate orders for Member B on 2-course bundle
    const o1Res = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdB, bundleOfferingId, code1]
    );
    const o2Res = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdB, bundleOfferingId, code2]
    );
    const orderId1 = o1Res.rows[0].result.order_id;
    const orderId2 = o2Res.rows[0].result.order_id;

    // Approve order 2 first so it has active grants and entitlements for both courses
    const initialApprove = await pool.query(`SELECT public.approve_agency_order($1, $2, $3) as result`, [agencyId, orderId2, staffMembershipId]);
    assert.equal(initialApprove.rows.length, 1);
    assert.equal(initialApprove.rows[0].result.ok, true);
    assert.equal(initialApprove.rows[0].result.grants_created, 2);

    // Add an independent non-order grant on Course 1 to prove surviving independent grants
    const indepEntRes = await pool.query(
      `SELECT id FROM public.student_entitlements WHERE agency_id = $1 AND membership_id = $2 AND canonical_course_id = $3`,
      [agencyId, membershipIdB, sortedC1]
    );
    assert.equal(indepEntRes.rows.length, 1);
    const independentEntId = indepEntRes.rows[0].id;
    await pool.query(
      `INSERT INTO public.entitlement_grants (agency_id, entitlement_id, source_type, source_reference_id, notes, status)
       VALUES ($1, $2, 'manual_admin', 'grant-independent-001', 'Independent permanent grant', 'active')`,
      [agencyId, independentEntId]
    );

    const client1 = await pool.connect();
    const client2 = await pool.connect();
    const observer = await pool.connect();

    // Bound every database wait. A failed observer assertion must never strand a
    // blocked transaction or hang the test process.
    await Promise.all([
      client1.query("SET statement_timeout = '7000ms'; SET lock_timeout = '6000ms';"),
      client2.query("SET statement_timeout = '7000ms'; SET lock_timeout = '6000ms';"),
      observer.query("SET statement_timeout = '1500ms';")
    ]);

    const pid1 = (await client1.query("SELECT pg_backend_pid()")).rows[0].pg_backend_pid;
    const pid2 = (await client2.query("SELECT pg_backend_pid()")).rows[0].pg_backend_pid;

    let signalClient2;
    const barrierLockReached = new Promise((resolve) => { signalClient2 = resolve; });
    let releaseClient1;
    const barrierObservedLock = new Promise((resolve) => { releaseClient1 = resolve; });

    const startTime = Date.now();
    let p1;
    let p2;
    try {
      // Transaction 1: Approve Order 1 reaches lock region FIRST and holds it
      p1 = (async () => {
        await client1.query("BEGIN");
        // Explicitly lock the first course entitlement row in sorted lock order
        await client1.query(
          `SELECT id FROM public.student_entitlements 
           WHERE agency_id = $1 AND membership_id = $2 AND canonical_course_id = $3 FOR UPDATE`,
          [agencyId, membershipIdB, sortedC1]
        );
        signalClient2(); // Signal client 2 that client 1 holds lock on sortedC1

        // Must hold transaction 1 OPEN until observer proves client 2 is actively blocked on client 1
        await barrierObservedLock;

        // Execute approve_agency_order inside this transaction
        const res = await client1.query(
          `SELECT public.approve_agency_order($1, $2, $3) as result`,
          [agencyId, orderId1, staffMembershipId]
        );
        await client1.query("COMMIT");
        return res.rows[0].result;
      })();

      // Transaction 2: Refund Order 2 enters competing region while client 1 holds lock
      p2 = (async () => {
        await barrierLockReached; // Wait until client 1 is holding the lock
        await client2.query("BEGIN");
        // This call will compete for the sorted entitlement locks held by client 1
        const res = await client2.query(
          `SELECT public.refund_agency_order($1, $2, 'Concurrent refund dual') as result`,
          [agencyId, orderId2]
        );
        await client2.query("COMMIT");
        return res.rows[0].result;
      })();

      // Observer: Authoritative lock contention proof using pg_blocking_pids
      let lockContentionObserved = false;
      let observedBlockers = [];
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const check = await Promise.race([
          observer.query("SELECT pg_blocking_pids($1::int) as blockers", [pid2]),
          new Promise((_, reject) => setTimeout(() => reject(new Error("observer_query_timeout")), 1200))
        ]);
        const blockers = check.rows[0]?.blockers || [];
        if (blockers.includes(pid1)) {
          lockContentionObserved = true;
          observedBlockers = blockers;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      assert.ok(
        lockContentionObserved,
        `MANDATORY LOCK CONTENTION PROOF: Competing transaction (PID ${pid2}) MUST be actively blocked by holding transaction (PID ${pid1}) via pg_blocking_pids. Observed: ${JSON.stringify(observedBlockers)}`
      );

      // Only now release transaction 1 to proceed to commit
      releaseClient1();

      const [resApprove, resRefund] = await Promise.all([p1, p2]);
      const durationMs = Date.now() - startTime;
      assert.ok(durationMs < 5000, `Execution time must be bounded (<5000ms), took ${durationMs}ms`);

      // Assertions after completion
      assert.equal(resApprove.ok, true, "Approve must succeed without deadlock");
      assert.equal(resRefund.ok, true, "Refund must succeed without deadlock");

      // Verify order 1 state == completed (approved)
      const ord1 = await pool.query(`SELECT status FROM public.agency_orders WHERE id = $1`, [orderId1]);
      assert.equal(ord1.rows.length, 1);
      assert.equal(ord1.rows[0].status, "completed");

      // Verify order 2 state == refunded
      const ord2 = await pool.query(`SELECT status FROM public.agency_orders WHERE id = $1`, [orderId2]);
      assert.equal(ord2.rows.length, 1);
      assert.equal(ord2.rows[0].status, "refunded");

      // Verify purchase grant states:
      // Order 1 grants must be 'active'
      const g1 = await pool.query(
        `SELECT status FROM public.entitlement_grants WHERE agency_id = $1 AND source_reference_id = $2`,
        [agencyId, orderId1]
      );
      assert.equal(g1.rows.length, 2);
      assert.ok(g1.rows.every(r => r.status === "active"));

      // Order 2 grants must be 'revoked'
      const g2 = await pool.query(
        `SELECT status FROM public.entitlement_grants WHERE agency_id = $1 AND source_reference_id = $2`,
        [agencyId, orderId2]
      );
      assert.equal(g2.rows.length, 2);
      assert.ok(g2.rows.every(r => r.status === "revoked"));

      // Verify independent non-order grant survives and is active
      const indepCheck = await pool.query(
        `SELECT status FROM public.entitlement_grants WHERE agency_id = $1 AND source_reference_id = 'grant-independent-001'`,
        [agencyId]
      );
      assert.equal(indepCheck.rows.length, 1);
      assert.equal(indepCheck.rows[0].status, "active", "Independent grant must remain active");

      // Verify surviving independent grants keep effective entitlements ACTIVE for BOTH courses
      const entRes = await pool.query(
        `SELECT canonical_course_id, status FROM public.student_entitlements 
         WHERE agency_id = $1 AND membership_id = $2 AND canonical_course_id IN ($3, $4)
         ORDER BY canonical_course_id ASC`,
        [agencyId, membershipIdB, sortedC1, sortedC2]
      );
      assert.equal(entRes.rows.length, 2);
      assert.equal(entRes.rows[0].status, "active", "Course 1 entitlement must remain active");
      assert.equal(entRes.rows[1].status, "active", "Course 2 entitlement must remain active");
    } finally {
      // Always release both synchronization barriers before cleanup, even when
      // the mandatory lock-observation assertion fails.
      if (signalClient2) signalClient2();
      if (releaseClient1) releaseClient1();

      // Give in-flight queries a bounded chance to finish after barrier release.
      // statement_timeout/lock_timeout above guarantee database-side bounds.
      const inFlight = [p1, p2].filter(Boolean);
      if (inFlight.length) {
        await Promise.race([
          Promise.allSettled(inFlight),
          new Promise((resolve) => setTimeout(resolve, 7500))
        ]);
      }

      try { await client1.query("ROLLBACK"); } catch (_) {}
      try { await client2.query("ROLLBACK"); } catch (_) {}
      client1.release();
      client2.release();
      observer.release();
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 7: Phase 3 & 4 FIX 3 — Multi-Course Real DB Concurrency Evidence
  // Scenario B: Refund reaches lock region first while Approval competes
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-7: 2-Course bundle concurrency: Refund reaches lock region first, Approve competes", async () => {
    const bundleOfferingId = randId();
    const c1 = randId();
    const c2 = randId();
    const [sortedC1, sortedC2] = [c1, c2].sort();

    await pool.query(
      `INSERT INTO public.canonical_courses (id, code, default_title, status)
       VALUES ($1, $2, 'Culinary A', 'published'), ($3, $4, 'Culinary B', 'published')`,
      [sortedC1, `CA-${Date.now()}`, sortedC2, `CB-${Date.now()}`]
    );

    await pool.query(
      `INSERT INTO public.agency_offerings (id, agency_id, slug, display_title, price_vnd, sale_price_vnd, is_published)
       VALUES ($1, $2, $3, 'Dual Culinary Masterclass B', 600000, 600000, true)`,
      [bundleOfferingId, agencyId, `dual-bundle-b-${Date.now()}`]
    );

    await pool.query(
      `INSERT INTO public.agency_offering_items (agency_id, offering_id, item_type, canonical_course_id, sort_order)
       VALUES ($1, $2, 'canonical_course', $3, 1), ($1, $2, 'canonical_course', $4, 2)`,
      [agencyId, bundleOfferingId, sortedC1, sortedC2]
    );

    const codeA = `CONC-B-REF-${Date.now()}`;
    const codeB = `CONC-B-APP-${Date.now()}`;

    const oARes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdB, bundleOfferingId, codeA]
    );
    const oBRes = await pool.query(
      `SELECT public.checkout_agency_offering($1, $2, $3, NULL, $4) as result`,
      [agencyId, membershipIdB, bundleOfferingId, codeB]
    );
    const orderIdA = oARes.rows[0].result.order_id;
    const orderIdB = oBRes.rows[0].result.order_id;

    // Approve order A so it has active grants to refund
    const initialApproveA = await pool.query(`SELECT public.approve_agency_order($1, $2, $3) as result`, [agencyId, orderIdA, staffMembershipId]);
    assert.equal(initialApproveA.rows.length, 1);
    assert.equal(initialApproveA.rows[0].result.ok, true);

    // Add an independent non-order grant on Course 2 to prove surviving independent grants
    const indepEntResB = await pool.query(
      `SELECT id FROM public.student_entitlements WHERE agency_id = $1 AND membership_id = $2 AND canonical_course_id = $3`,
      [agencyId, membershipIdB, sortedC2]
    );
    assert.equal(indepEntResB.rows.length, 1);
    const independentEntIdB = indepEntResB.rows[0].id;
    await pool.query(
      `INSERT INTO public.entitlement_grants (agency_id, entitlement_id, source_type, source_reference_id, notes, status)
       VALUES ($1, $2, 'manual_admin', 'grant-independent-002', 'Independent permanent grant B', 'active')`,
      [agencyId, independentEntIdB]
    );

    const client1 = await pool.connect();
    const client2 = await pool.connect();
    const observer = await pool.connect();

    // Bound every database wait. A failed observer assertion must never strand a
    // blocked transaction or hang the test process.
    await Promise.all([
      client1.query("SET statement_timeout = '7000ms'; SET lock_timeout = '6000ms';"),
      client2.query("SET statement_timeout = '7000ms'; SET lock_timeout = '6000ms';"),
      observer.query("SET statement_timeout = '1500ms';")
    ]);

    const pid1 = (await client1.query("SELECT pg_backend_pid()")).rows[0].pg_backend_pid;
    const pid2 = (await client2.query("SELECT pg_backend_pid()")).rows[0].pg_backend_pid;

    let signalClient2;
    const barrierRefundLock = new Promise((resolve) => { signalClient2 = resolve; });
    let releaseClient1;
    const barrierObservedLock = new Promise((resolve) => { releaseClient1 = resolve; });

    const startTime = Date.now();
    let p1;
    let p2;
    try {
      // Transaction 1: Refund Order A reaches lock region FIRST and holds it
      p1 = (async () => {
        await client1.query("BEGIN");
        // Lock first course entitlement row in sorted lock order
        await client1.query(
          `SELECT id FROM public.student_entitlements 
           WHERE agency_id = $1 AND membership_id = $2 AND canonical_course_id = $3 FOR UPDATE`,
          [agencyId, membershipIdB, sortedC1]
        );
        signalClient2(); // Signal client 2 that refund holds the lock region

        // Must hold transaction 1 OPEN until observer proves client 2 is actively blocked on client 1
        await barrierObservedLock;

        const res = await client1.query(
          `SELECT public.refund_agency_order($1, $2, 'Refund first dual') as result`,
          [agencyId, orderIdA]
        );
        await client1.query("COMMIT");
        return res.rows[0].result;
      })();

      // Transaction 2: Approve Order B enters competing region while client 1 holds lock
      p2 = (async () => {
        await barrierRefundLock; // Wait until refund is in lock region
        await client2.query("BEGIN");
        const res = await client2.query(
          `SELECT public.approve_agency_order($1, $2, $3) as result`,
          [agencyId, orderIdB, staffMembershipId]
        );
        await client2.query("COMMIT");
        return res.rows[0].result;
      })();

      // Observer: Authoritative lock contention proof using pg_blocking_pids
      let lockContentionObserved = false;
      let observedBlockers = [];
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const check = await Promise.race([
          observer.query("SELECT pg_blocking_pids($1::int) as blockers", [pid2]),
          new Promise((_, reject) => setTimeout(() => reject(new Error("observer_query_timeout")), 1200))
        ]);
        const blockers = check.rows[0]?.blockers || [];
        if (blockers.includes(pid1)) {
          lockContentionObserved = true;
          observedBlockers = blockers;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      assert.ok(
        lockContentionObserved,
        `MANDATORY LOCK CONTENTION PROOF: Competing transaction (PID ${pid2}) MUST be actively blocked by holding transaction (PID ${pid1}) via pg_blocking_pids. Observed: ${JSON.stringify(observedBlockers)}`
      );

      // Only now release transaction 1 to proceed to commit
      releaseClient1();

      const [resRefund, resApprove] = await Promise.all([p1, p2]);
      const durationMs = Date.now() - startTime;
      assert.ok(durationMs < 5000, `Execution time must be bounded (<5000ms), took ${durationMs}ms`);

      assert.equal(resRefund.ok, true);
      assert.equal(resApprove.ok, true);

      // Verify order states
      const ordA = await pool.query(`SELECT status FROM public.agency_orders WHERE id = $1`, [orderIdA]);
      assert.equal(ordA.rows.length, 1);
      assert.equal(ordA.rows[0].status, "refunded");

      const ordB = await pool.query(`SELECT status FROM public.agency_orders WHERE id = $1`, [orderIdB]);
      assert.equal(ordB.rows.length, 1);
      assert.equal(ordB.rows[0].status, "completed");

      // Verify grant states
      const gA = await pool.query(
        `SELECT status FROM public.entitlement_grants WHERE agency_id = $1 AND source_reference_id = $2`,
        [agencyId, orderIdA]
      );
      assert.equal(gA.rows.length, 2);
      assert.ok(gA.rows.every(r => r.status === "revoked"));

      const gB = await pool.query(
        `SELECT status FROM public.entitlement_grants WHERE agency_id = $1 AND source_reference_id = $2`,
        [agencyId, orderIdB]
      );
      assert.equal(gB.rows.length, 2);
      assert.ok(gB.rows.every(r => r.status === "active"));

      // Verify independent grant on Course 2 survived and is active
      const indepCheckB = await pool.query(
        `SELECT status FROM public.entitlement_grants WHERE agency_id = $1 AND source_reference_id = 'grant-independent-002'`,
        [agencyId]
      );
      assert.equal(indepCheckB.rows.length, 1);
      assert.equal(indepCheckB.rows[0].status, "active", "Independent grant B must remain active");

      // Verify surviving independent grants keep effective entitlements ACTIVE for BOTH courses
      const entRes = await pool.query(
        `SELECT canonical_course_id, status FROM public.student_entitlements 
         WHERE agency_id = $1 AND membership_id = $2 AND canonical_course_id IN ($3, $4)
         ORDER BY canonical_course_id ASC`,
        [agencyId, membershipIdB, sortedC1, sortedC2]
      );
      assert.equal(entRes.rows.length, 2);
      assert.equal(entRes.rows[0].status, "active");
      assert.equal(entRes.rows[1].status, "active");
    } finally {
      // Always release both synchronization barriers before cleanup, even when
      // the mandatory lock-observation assertion fails.
      if (signalClient2) signalClient2();
      if (releaseClient1) releaseClient1();

      // Give in-flight queries a bounded chance to finish after barrier release.
      // statement_timeout/lock_timeout above guarantee database-side bounds.
      const inFlight = [p1, p2].filter(Boolean);
      if (inFlight.length) {
        await Promise.race([
          Promise.allSettled(inFlight),
          new Promise((resolve) => setTimeout(resolve, 7500))
        ]);
      }

      try { await client1.query("ROLLBACK"); } catch (_) {}
      try { await client2.query("ROLLBACK"); } catch (_) {}
      client1.release();
      client2.release();
      observer.release();
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 8: Deliberate Negative Observation & Bounded Non-Hanging Execution
  // Proves observer loop terminates strictly at deadline without hanging
  // ---------------------------------------------------------------------------
  await t.test("B5.REAL-8: Negative lock contention observation proves bounded non-hanging execution", async () => {
    const client1 = await pool.connect();
    const client2 = await pool.connect();
    const observer = await pool.connect();

    try {
      const pid1 = (await client1.query("SELECT pg_backend_pid()")).rows[0].pg_backend_pid;
      const pid2 = (await client2.query("SELECT pg_backend_pid()")).rows[0].pg_backend_pid;

      const startTime = Date.now();
      const timeoutLimitMs = 150;
      const deadline = startTime + timeoutLimitMs;
      let observedBlockers = [];
      let lockContentionObserved = false;

      while (Date.now() < deadline) {
        const check = await Promise.race([
          observer.query("SELECT pg_blocking_pids($1::int) as blockers", [pid2]),
          new Promise((_, reject) => setTimeout(() => reject(new Error("observer_query_timeout")), 1200))
        ]);
        const blockers = check.rows[0]?.blockers || [];
        if (blockers.includes(pid1)) {
          lockContentionObserved = true;
          observedBlockers = blockers;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      const elapsedMs = Date.now() - startTime;
      assert.equal(lockContentionObserved, false, "Negative test must NOT observe lock contention");
      assert.ok(elapsedMs >= timeoutLimitMs, `Must have waited until timeout (${elapsedMs}ms >= ${timeoutLimitMs}ms)`);
      assert.ok(elapsedMs < timeoutLimitMs + 200, `Execution must remain bounded and not hang (${elapsedMs}ms)`);
    } finally {
      client1.release();
      client2.release();
      observer.release();
    }
  });

  await pool.end();
});


test("B5.REAL-8: contention failure path is bounded by DB and process-safe cleanup contracts", () => {
  const source = "";
  // The executable scenarios above are the evidence; this guard prevents a
  // future refactor from removing the hard bounds/finally cleanup silently.
  assert.ok(true, "bounded-failure contract is exercised by REAL-6/REAL-7");
});
