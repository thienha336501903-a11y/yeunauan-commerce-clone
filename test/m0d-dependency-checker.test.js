// test/m0d-dependency-checker.test.js
// Automated test suite for System B Phase 17: M0D Dependency Checker & Cutover Matrix
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Invariants:
//   - Audits all 7 required surfaces starting from real entrypoints.
//   - Injected legacy import in entrypoint => FAIL.
//   - Indirect imported legacy dependency => FAIL.
//   - Missing entrypoint evidence => UNKNOWN/FAIL.
//   - Never defaults LEGACY_REQUIRED = NO without evidence.
//   - M0D_EXECUTION strictly NOT_STARTED.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  generateLegacyDependencyMatrix,
  checkM0dCutoverReadiness,
  auditFileContent,
  auditEntrypointRouting,
  REQUIRED_SURFACES
} from "../utils/m0d-dependency-checker.js";

test("M0D-DEPENDENCY-CHECKER: Real Entrypoint & Surface Dependency Matrix", async (t) => {
  // ---------------------------------------------------------------------------
  // 1. Audit Live Codebase
  // ---------------------------------------------------------------------------
  await t.test("M0D.1: Live codebase matrix verifies all surfaces pass without legacy leaks", () => {
    const res = checkM0dCutoverReadiness();
    assert.equal(res.ok, true);
    assert.equal(res.M0D_DEPENDENCY_MATRIX, "PASS");
    assert.equal(res.M0D_CUTOVER_CHECKER, "PASS");
    assert.equal(res.M0D_EXECUTION, "NOT_STARTED");

    assert.equal(res.gates.AGENCY_HOST_ROUTES_NEVER_FALL_TO_LEGACY, true);
    assert.equal(res.gates.AUTHENTICATED_AGENCY_USER_NEVER_USES_HMAC, true);
    assert.equal(res.gates.COMMERCE_USES_AGENCY_TABLES_EXCLUSIVELY, true);
    assert.equal(res.gates.ENTITLEMENT_USES_NEW_GRANT_MODEL, true);
    assert.equal(res.gates.PLAYBACK_USES_B1_1_AGENCY_AUTHORIZATION, true);
    assert.equal(res.gates.PROGRESS_USES_AGENCY_SCOPED_PROGRESS, true);
    assert.equal(res.gates.HOMEWORK_USES_AGENCY_SCOPED_MODEL, true);
    assert.equal(res.gates.NO_AGENCY_REQUESTS_REQUIRE_LEGACY_DB, true);
  });

  // ---------------------------------------------------------------------------
  // 2. Regression: Injected Legacy Pattern in Agency Module => FAIL
  // ---------------------------------------------------------------------------
  await t.test("M0D.2: Prohibited legacy pattern in agency module causes FAIL", () => {
    const taintedCode = `
      import { supabase } from "./supabase.js";
      export async function getEnrollments(req) {
        return supabase.from("student_enrollments").select("*");
      }
    `;
    const violations = auditFileContent("utils/fake-agency.js", taintedCode);
    assert.ok(violations.length > 0);
    assert.equal(violations[0].pattern, "unscoped_student_enrollments");
  });

  // ---------------------------------------------------------------------------
  // 3. Regression: Injected Legacy HMAC Session => FAIL
  // ---------------------------------------------------------------------------
  await t.test("M0D.3: Injected legacy HMAC auth pattern causes FAIL", () => {
    const taintedCode = `
      export function authenticateUser(req) {
        return verifyHmacSession(req.cookies.session);
      }
    `;
    const violations = auditFileContent("utils/fake-auth.js", taintedCode);
    assert.ok(violations.length > 0);
    assert.equal(violations[0].pattern, "legacy_hmac_session");
  });

  // ---------------------------------------------------------------------------
  // 4. Regression: Missing Routing Guard in Entrypoint => Detected
  // ---------------------------------------------------------------------------
  await t.test("M0D.4: Entrypoint missing routing guard is detected", () => {
    const unguardedCode = `
      export default function handler(req, res) {
        return res.status(200).json({ ok: true });
      }
    `;
    const routing = auditEntrypointRouting("api/unguarded.js", unguardedCode);
    assert.equal(routing.hasRoutingGuard, false);
    assert.equal(routing.hasAgencyBranch, false);
  });

  // ---------------------------------------------------------------------------
  // 5. Surface Completeness: All 7 required surfaces audited
  // ---------------------------------------------------------------------------
  await t.test("M0D.5: All 7 required surfaces are present in definition", () => {
    const surfaceNames = REQUIRED_SURFACES.map(s => s.surface);
    const required = [
      "storefront",
      "checkout",
      "agency admin",
      "learner",
      "learning/player",
      "homework",
      "V5 playback"
    ];
    for (const req of required) {
      assert.ok(surfaceNames.includes(req), `Missing required surface: ${req}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Isolated Synthetic Directory Test (Missing files => UNKNOWN)
  // ---------------------------------------------------------------------------
  await t.test("M0D.6: Synthetic empty root produces UNKNOWN instead of false PASS", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "m0d-test-"));
    try {
      const res = generateLegacyDependencyMatrix(tempDir);
      assert.equal(res.summary.passedSurfaces, 0);
      assert.equal(res.summary.unknownSurfaces, REQUIRED_SURFACES.length);
      for (const row of res.matrix) {
        assert.equal(row.status, "UNKNOWN");
        assert.equal(row.LEGACY_REQUIRED, "UNKNOWN");
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
