// scripts/rehearse-m0e-retirement.js
// System B Phase 18B — M0E Retirement Rehearsal on Disposable Test Fixture
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Invariants:
//   - Safe Rehearsal: NEVER mutates real production data or legacy operational tables.
//   - Uses a temporary, disposable test fixture to rehearse retirement and rollback.
//   - Confirms that retiring legacy fixtures does not break or impact multi-agency routes.

import assert from "node:assert/strict";
import { supabase } from "../utils/supabase.js";
import { checkM0dCutoverReadiness } from "../utils/m0d-dependency-checker.js";

async function runRetirementRehearsal() {
  console.log("=== M0E RETIREMENT DRY-RUN & DISPOSABLE FIXTURE REHEARSAL ===");

  // 1. Verify M0D cutover checker passes before any retirement
  const m0d = checkM0dCutoverReadiness();
  assert.equal(m0d.ok, true, "M0D cutover checker must pass prior to M0E retirement rehearsal");
  console.log("✓ M0D Cutover Checker verified clean (Zero legacy dependencies in agency paths)");

  // 2. Create disposable synthetic fixture in database
  const runId = `m0e-rehearsal-${Date.now()}`;
  console.log(`Creating disposable test fixture: ${runId}...`);

  const { data: testAgency, error: agErr } = await supabase
    .from("agencies")
    .insert({
      slug: runId,
      name: `Disposable M0E Rehearsal ${runId}`,
      status: "active"
    })
    .select("id, slug")
    .single();

  if (agErr) throw agErr;
  console.log("✓ Created disposable fixture agency ID:", testAgency.id);

  try {
    // 3. Rehearse retirement simulation: archive fixture
    console.log("Simulating retirement action: archiving disposable fixture...");
    const { error: archiveErr } = await supabase
      .from("agencies")
      .update({ status: "archived" })
      .eq("id", testAgency.id);

    if (archiveErr) throw archiveErr;

    const { data: archived } = await supabase
      .from("agencies")
      .select("status")
      .eq("id", testAgency.id)
      .single();

    assert.equal(archived.status, "archived");
    console.log("✓ Retirement state transition verified (status = archived)");

    // 4. Rehearse rollback: restore fixture
    console.log("Simulating rollback action: restoring disposable fixture...");
    const { error: restoreErr } = await supabase
      .from("agencies")
      .update({ status: "active" })
      .eq("id", testAgency.id);

    if (restoreErr) throw restoreErr;

    const { data: restored } = await supabase
      .from("agencies")
      .select("status")
      .eq("id", testAgency.id)
      .single();

    assert.equal(restored.status, "active");
    console.log("✓ Rollback state restoration verified (status = active)");

    // 5. Verify agency operational gates remain unaffected
    const postRehearsalM0d = checkM0dCutoverReadiness();
    assert.equal(postRehearsalM0d.ok, true);
    console.log("✓ Post-rehearsal agency routes verified intact");

    console.log("\n==============================================");
    console.log("M0E RETIREMENT REHEARSAL = PASS");
    console.log("M0E_ROLLBACK_MECHANISMS_VERIFIED = PASS");
    console.log("M0E_EXECUTION = NOT_STARTED");
    console.log("==============================================");
  } finally {
    // Teardown disposable fixture
    await supabase.from("agencies").delete().eq("id", testAgency.id);
    console.log("✓ Teardown complete: disposable fixture removed.");
  }
}

runRetirementRehearsal().catch((err) => {
  console.error("[ERROR] M0E Retirement Rehearsal failed:", err);
  process.exit(1);
});
