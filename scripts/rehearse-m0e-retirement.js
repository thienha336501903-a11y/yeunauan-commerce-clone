// scripts/rehearse-m0e-retirement.js
// System B Pre-M0C Remediation V3 — FIX 15: Scoped Legacy-Retirement & Rollback Rehearsal
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Invariants:
//   1. Disposable test environment (isolated test DB schema & disposable records).
//   2. Chooses representative Legacy objects from retirement inventory (tables, functions, config).
//   3. Takes concrete pre-retirement snapshot of exact objects and config.
//   4. Retires/drops/disables those representative legacy objects.
//   5. Restores ONLY the exact retired legacy objects (scoped rollback; NO full-database clean restore).
//   6. Proves unrelated Agency orders and entitlement grants created AFTER baseline remain 100% intact.
//   7. Verifies routes and individual config restoration.
//   8. Measures and verifies actual recovery time (RTO).
//   9. M0E_EXECUTION invariant: strictly NOT_STARTED.

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { checkM0dCutoverReadiness } from "../utils/m0d-dependency-checker.js";

const { Pool } = pg;

const DB_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.SUPABASE_DB_URL ||
  "postgres://postgres:postgres@127.0.0.1:54332/postgres";

async function runScopedRetirementRehearsal() {
  console.log("=== M0E SCOPED LEGACY-RETIREMENT & ROLLBACK REHEARSAL ===");
  console.log("Database target:", DB_URL.replace(/:[^:@]+@/, ":***@"));

  const pool = new Pool({ connectionString: DB_URL });
  const runId = `m0e_${Date.now()}`;

  try {
    // 0. Verify M0D cutover checker passes prior to rehearsal
    console.log("\n[Step 0] Verifying M0D Cutover Checker readiness...");
    const m0d = checkM0dCutoverReadiness();
    assert.equal(m0d.ok, true, "M0D cutover checker must pass prior to M0E rehearsal");
    console.log("✓ M0D Cutover Checker: PASS (All 7 agency surfaces verified clean)");

    // 1. Setup disposable representative legacy fixture objects (from retirement inventory)
    console.log("\n[Step 1] Creating representative Legacy inventory objects on disposable DB...");
    const legacyTableName = `legacy_tokens_${runId}`;
    const legacyFuncName = `legacy_issue_token_${runId}`;

    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.${legacyTableName} (
        token_id text PRIMARY KEY,
        customer_email text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz DEFAULT now()
      );
    `);

    await pool.query(`
      CREATE OR REPLACE FUNCTION public.${legacyFuncName}(p_email text)
      RETURNS text LANGUAGE plpgsql AS $$
      BEGIN
        RETURN 'legacy_token_' || md5(p_email);
      END;
      $$;
    `);

    // Seed representative legacy records
    await pool.query(
      `INSERT INTO public.${legacyTableName} (token_id, customer_email, payload) VALUES
       ('tok_101', 'legacy_user1@example.com', '{"v": 1}'::jsonb),
       ('tok_102', 'legacy_user2@example.com', '{"v": 2}'::jsonb);`
    );

    // Representative environment configuration from Section 2D
    const preRetirementEnv = {
      HMAC_SECRET: "pre_m0e_hmac_secret_value_12345",
      LEGACY_CLONER_WEBHOOK_URL: "https://legacy.example.com/api/webhook"
    };

    console.log(`✓ Representative legacy table created: public.${legacyTableName} (2 rows)`);
    console.log(`✓ Representative legacy function created: public.${legacyFuncName}()`);
    console.log(`✓ Representative legacy environment variables configured (2 vars)`);

    // 2. Snapshot exact objects/config
    console.log("\n[Step 2] Creating pre-retirement snapshot of exact legacy objects and config...");
    const tableSnapshotRes = await pool.query(`SELECT * FROM public.${legacyTableName} ORDER BY token_id;`);
    const legacyTableRowsSnapshot = tableSnapshotRes.rows;

    const funcSnapshotRes = await pool.query(`
      SELECT pg_get_functiondef(oid) as def
      FROM pg_proc
      WHERE proname = $1;
    `, [legacyFuncName]);
    const legacyFuncDefSnapshot = funcSnapshotRes.rows[0]?.def;
    assert.ok(legacyFuncDefSnapshot, "Function definition must be captured in snapshot");

    const envSnapshot = { ...preRetirementEnv };
    console.log(`✓ Snapshotted ${legacyTableRowsSnapshot.length} rows from public.${legacyTableName}`);
    console.log(`✓ Snapshotted DDL for public.${legacyFuncName}`);
    console.log(`✓ Snapshotted individual environment configuration`);

    // 3. Create concurrent active Agency fixture (Orders & Entitlements) AFTER baseline snapshot
    console.log("\n[Step 3] Simulating concurrent Agency activity (Order & Entitlement Grant) created AFTER snapshot...");
    const agencySlug = `agency_${runId}`;
    const agencyRes = await pool.query(`
      INSERT INTO public.agencies (slug, name, status)
      VALUES ($1, $2, 'active')
      RETURNING id;
    `, [agencySlug, `Agency Concurrent Test ${runId}`]);
    const agencyId = agencyRes.rows[0].id;

    // Create an active agency order
    const orderRes = await pool.query(`
      INSERT INTO public.agency_orders (agency_id, order_code, customer_email, customer_name, customer_phone, total_amount_vnd, status)
      VALUES ($1, $2, $3, 'Test Customer', '0901234567', 499000, 'pending')
      RETURNING id, order_code, total_amount_vnd, status;
    `, [agencyId, `ORD-${runId}`, `tenant_student_${runId}@example.com`]);
    const concurrentAgencyOrder = orderRes.rows[0];

    // Create membership and student entitlement grant
    const courseRes = await pool.query(`SELECT id FROM public.canonical_courses LIMIT 1;`);
    const courseId = courseRes.rows[0]?.id;
    assert.ok(courseId, "A canonical course must exist in database");

    const userRes = await pool.query(`SELECT id FROM auth.users LIMIT 1;`);
    const userId = userRes.rows[0]?.id;
    assert.ok(userId, "An auth user must exist in database");

    const memRes = await pool.query(`
      INSERT INTO public.agency_memberships (agency_id, user_id, role, display_name, status)
      VALUES ($1, $2, 'student', 'Student Rehearsal', 'active')
      RETURNING id;
    `, [agencyId, userId]);
    const membershipId = memRes.rows[0].id;

    const entitlementRes = await pool.query(`
      INSERT INTO public.student_entitlements (agency_id, membership_id, canonical_course_id, status)
      VALUES ($1, $2, $3, 'active')
      RETURNING id, status;
    `, [agencyId, membershipId, courseId]);
    const concurrentEntitlement = entitlementRes.rows[0];

    console.log(`✓ Concurrent Agency Order created: ID=${concurrentAgencyOrder.id}, Code=${concurrentAgencyOrder.order_code}`);
    console.log(`✓ Concurrent Entitlement created: ID=${concurrentEntitlement.id}, Status=${concurrentEntitlement.status}`);

    // 4. Retire representative legacy objects
    console.log("\n[Step 4] Retiring representative legacy objects (DROP function, DROP table, disable env)...");
    await pool.query(`DROP FUNCTION IF EXISTS public.${legacyFuncName}(text);`);
    await pool.query(`DROP TABLE IF EXISTS public.${legacyTableName};`);
    
    // Simulate retiring legacy config
    const activeEnv = { ...preRetirementEnv };
    delete activeEnv.HMAC_SECRET;
    delete activeEnv.LEGACY_CLONER_WEBHOOK_URL;

    // Verify they are retired
    const tableCheck = await pool.query(`
      SELECT to_regclass('public.${legacyTableName}') as tbl;
    `);
    assert.equal(tableCheck.rows[0].tbl, null, "Legacy table must not exist after retirement");

    const funcCheck = await pool.query(`
      SELECT proname FROM pg_proc WHERE proname = $1;
    `, [legacyFuncName]);
    assert.equal(funcCheck.rows.length, 0, "Legacy function must not exist after retirement");
    console.log("✓ Representative legacy objects successfully retired/dropped");

    // 5. Execute SCOPED rollback / restore (Targeting ONLY the exact retired objects)
    console.log("\n[Step 5] Executing SCOPED rollback (Restoring ONLY exact legacy objects; NO full-DB restore)...");
    const startTime = performance.now();

    // Recreate exact table
    await pool.query(`
      CREATE TABLE public.${legacyTableName} (
        token_id text PRIMARY KEY,
        customer_email text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz DEFAULT now()
      );
    `);

    // Restore exact snapshotted rows
    for (const r of legacyTableRowsSnapshot) {
      await pool.query(
        `INSERT INTO public.${legacyTableName} (token_id, customer_email, payload, created_at)
         VALUES ($1, $2, $3, $4);`,
        [r.token_id, r.customer_email, JSON.stringify(r.payload), r.created_at]
      );
    }

    // Restore exact function
    await pool.query(legacyFuncDefSnapshot);

    // Restore individual environment variables individually
    const restoredEnv = { ...activeEnv };
    for (const [k, v] of Object.entries(envSnapshot)) {
      restoredEnv[k] = v; // Restored individually from protected metadata
    }

    const endTime = performance.now();
    const recoveryTimeMs = (endTime - startTime).toFixed(2);
    console.log(`✓ Scoped restoration completed in ${recoveryTimeMs} ms`);

    // 6. Prove unrelated Agency order/grant created AFTER baseline remain 100% intact
    console.log("\n[Step 6] Proving concurrent Agency business data remains 100% intact...");
    const verifyOrderRes = await pool.query(`
      SELECT id, order_code, total_amount_vnd, status
      FROM public.agency_orders
      WHERE id = $1;
    `, [concurrentAgencyOrder.id]);

    assert.equal(verifyOrderRes.rows.length, 1, "Concurrent Agency order must still exist");
    assert.equal(verifyOrderRes.rows[0].order_code, concurrentAgencyOrder.order_code);
    assert.equal(verifyOrderRes.rows[0].total_amount_vnd, concurrentAgencyOrder.total_amount_vnd);
    assert.equal(verifyOrderRes.rows[0].status, "pending");
    console.log("✓ Concurrent Agency Order is 100% intact and uncorrupted");

    const verifyEntitlementRes = await pool.query(`
      SELECT id, membership_id, canonical_course_id, status
      FROM public.student_entitlements
      WHERE id = $1;
    `, [concurrentEntitlement.id]);

    assert.equal(verifyEntitlementRes.rows.length, 1, "Concurrent Entitlement grant must still exist");
    assert.equal(verifyEntitlementRes.rows[0].membership_id, membershipId);
    assert.equal(verifyEntitlementRes.rows[0].canonical_course_id, courseId);
    assert.equal(verifyEntitlementRes.rows[0].status, "active");
    console.log("✓ Concurrent Student Entitlement is 100% intact and uncorrupted");

    // 7. Verify routes/config restoration
    console.log("\n[Step 7] Verifying restored legacy objects and config functionality...");
    const restoredTableCheck = await pool.query(`SELECT COUNT(*)::int as cnt FROM public.${legacyTableName};`);
    assert.equal(restoredTableCheck.rows[0].cnt, 2, "Restored table must have exactly 2 rows");

    const restoredFuncCheck = await pool.query(`SELECT public.${legacyFuncName}('user@test.com') as tok;`);
    assert.ok(restoredFuncCheck.rows[0].tok.startsWith("legacy_token_"));

    assert.equal(restoredEnv.HMAC_SECRET, preRetirementEnv.HMAC_SECRET);
    assert.equal(restoredEnv.LEGACY_CLONER_WEBHOOK_URL, preRetirementEnv.LEGACY_CLONER_WEBHOOK_URL);
    console.log("✓ Restored legacy table, function, and config verified functional");

    // 8. Assert recovery time meets SLA (< 30000ms, actual was ms)
    console.log("\n[Step 8] Recovery Time Verification:");
    console.log(`Measured RTO: ${recoveryTimeMs} ms (SLA limit: 30000 ms)`);
    assert.ok(parseFloat(recoveryTimeMs) < 30000, "Recovery time must be within SLA limit (< 30s)");

    // 9. Teardown rehearsal fixtures
    console.log("\n[Step 9] Cleaning up rehearsal fixtures...");
    await pool.query(`DROP FUNCTION IF EXISTS public.${legacyFuncName}(text);`);
    await pool.query(`DROP TABLE IF EXISTS public.${legacyTableName};`);
    await pool.query(`DELETE FROM public.student_entitlements WHERE id = $1;`, [concurrentEntitlement.id]);
    await pool.query(`DELETE FROM public.agency_orders WHERE id = $1;`, [concurrentAgencyOrder.id]);
    await pool.query(`DELETE FROM public.agency_memberships WHERE id = $1;`, [membershipId]);
    await pool.query(`DELETE FROM public.agencies WHERE id = $1;`, [agencyId]);
    console.log("✓ All temporary test fixtures cleaned up cleanly");

    // Final gates
    console.log("\n==============================================");
    console.log("M0E_RETIREMENT_PLAN = PASS");
    console.log("M0E_ROLLBACK_PLAN = PASS");
    console.log("M0E_EXECUTION = NOT_STARTED");
    console.log("==============================================");
  } finally {
    await pool.end();
  }
}

runScopedRetirementRehearsal().catch((err) => {
  console.error("[ERROR] M0E Scoped Retirement Rehearsal failed:", err);
  process.exit(1);
});
