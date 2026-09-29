import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateLegacyDependencyMatrix, checkM0dCutoverReadiness, REQUIRED_SURFACES } from "../utils/m0d-dependency-checker.js";

test("M0D readiness reports the actual schema and never promotes missing cross-repo evidence", () => {
  const result = checkM0dCutoverReadiness();
  const matrix = generateLegacyDependencyMatrix();
  assert.equal(matrix.matrix.length, REQUIRED_SURFACES.length);
  assert.equal(matrix.summary.totalSurfaces, REQUIRED_SURFACES.length);
  assert.equal(matrix.summary.passedSurfaces + matrix.summary.failedSurfaces + matrix.summary.unknownSurfaces,
    REQUIRED_SURFACES.length);
  assert.equal(result.M0D_DEPENDENCY_MATRIX, matrix.ok ? "PASS" : "FAIL");
  assert.equal(result.M0D_CUTOVER_CHECKER, result.ok ? "PASS" : "FAIL");
  assert.equal(result.M0D_EXECUTION, "NOT_STARTED");
  assert.deepEqual(Object.keys(result.gates).sort(), [
    "AGENCY_HOST_ROUTES_NEVER_FALL_TO_LEGACY", "AUTHENTICATED_AGENCY_USER_NEVER_USES_HMAC",
    "COMMERCE_USES_AGENCY_TABLES_EXCLUSIVELY", "ENTITLEMENT_USES_NEW_GRANT_MODEL",
    "PLAYBACK_USES_B1_1_AGENCY_AUTHORIZATION", "PROGRESS_USES_AGENCY_SCOPED_PROGRESS",
    "HOMEWORK_USES_AGENCY_SCOPED_MODEL", "NO_AGENCY_REQUESTS_REQUIRE_LEGACY_DB"
  ].sort());
  for (const row of matrix.matrix) {
    assert.ok(["PASS", "FAIL", "UNKNOWN"].includes(row.status));
    assert.equal(row.LEGACY_REQUIRED, row.status === "UNKNOWN" ? "UNKNOWN" : row.status === "FAIL" ? "YES" : "NO");
    assert.ok(Array.isArray(row.auditedFiles));
  }
});

test("M0D missing sibling stays UNKNOWN even if one repository contains Agency modules", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "m0d-sibling-"));
  const previous = process.env.M0D_SIBLING_ROOT;
  try {
    process.env.M0D_SIBLING_ROOT = empty;
    const result = checkM0dCutoverReadiness();
    assert.equal(result.ok, false);
    assert.equal(result.M0D_DEPENDENCY_MATRIX, "FAIL");
    assert.equal(result.summary.unknownSurfaces, REQUIRED_SURFACES.length);
    assert.ok(Object.values(result.gates).every(value => value === false));
  } finally {
    if (previous === undefined) delete process.env.M0D_SIBLING_ROOT;
    else process.env.M0D_SIBLING_ROOT = previous;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
