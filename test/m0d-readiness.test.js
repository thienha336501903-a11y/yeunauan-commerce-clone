// test/m0d-readiness.test.js
// Automated test suite for System B Milestone M0D Readiness & Legacy Dependency Audit
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Invariants:
//   - Verifies 0 accidental legacy references across all 7 new Agency functional paths.
//   - Verifies all 8 operational gates pass.
//   - Confirms M0D_EXECUTION is strictly NOT_STARTED.

import assert from "node:assert/strict";
import test from "node:test";
import { generateLegacyDependencyMatrix, checkM0dCutoverReadiness } from "../utils/m0d-dependency-checker.js";

test("M0D-READINESS: Legacy Dependency Matrix & Operational Cutover Gates", () => {
  // 1. Audit Dependency Matrix
  const matrixResult = generateLegacyDependencyMatrix();
  assert.equal(matrixResult.ok, true, "Dependency matrix must be 100% clean of legacy references in new Agency paths.");
  assert.equal(matrixResult.summary.violationsCount, 0);
  assert.equal(matrixResult.summary.cleanPaths, 7);

  for (const row of matrixResult.matrix) {
    assert.equal(row.LEGACY_REQUIRED, "NO", `Path '${row.pathName}' must not require legacy.`);
    assert.equal(row.LEGACY_REFERENCE_FOUND, "NO", `Path '${row.pathName}' must have no legacy references.`);
    assert.equal(row.BLOCKING_REFERENCE, null);
  }

  // 2. Audit Cutover Readiness
  const readiness = checkM0dCutoverReadiness();
  assert.equal(readiness.ok, true);
  assert.equal(readiness.M0D_READINESS_TOOLING, "PASS");
  assert.equal(readiness.M0D_EXECUTION, "NOT_STARTED");

  assert.equal(readiness.gates.AGENCY_HOST_ROUTES_NEVER_FALL_TO_LEGACY, true);
  assert.equal(readiness.gates.AUTHENTICATED_AGENCY_USER_NEVER_USES_HMAC, true);
  assert.equal(readiness.gates.COMMERCE_USES_AGENCY_TABLES_EXCLUSIVELY, true);
  assert.equal(readiness.gates.ENTITLEMENT_USES_NEW_GRANT_MODEL, true);
  assert.equal(readiness.gates.PLAYBACK_USES_B1_1_AGENCY_AUTHORIZATION, true);
  assert.equal(readiness.gates.PROGRESS_USES_AGENCY_SCOPED_PROGRESS, true);
  assert.equal(readiness.gates.HOMEWORK_USES_AGENCY_SCOPED_MODEL, true);
  assert.equal(readiness.gates.NO_AGENCY_REQUESTS_REQUIRE_LEGACY_DB, true);
});
