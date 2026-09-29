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
  traceTransitiveLocalImports,
  REQUIRED_SURFACES
} from "../utils/m0d-dependency-checker.js";

test("M0D-DEPENDENCY-CHECKER: Real Entrypoint & Surface Dependency Matrix", async (t) => {
  // ---------------------------------------------------------------------------
  // 1. Audit Live Codebase
  // ---------------------------------------------------------------------------
  await t.test("M0D.1: Live matrix reports its actual cutover status", () => {
    const res = checkM0dCutoverReadiness();
    assert.equal(res.ok, Object.values(res.gates).every(Boolean));
    assert.equal(res.M0D_DEPENDENCY_MATRIX, res.matrix.every(row => row.status === "PASS") ? "PASS" : "FAIL");
    assert.equal(res.M0D_CUTOVER_CHECKER, res.ok ? "PASS" : "FAIL");
    assert.equal(res.M0D_EXECUTION, "NOT_STARTED");

    assert.equal(res.summary.totalSurfaces, REQUIRED_SURFACES.length);
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

  await t.test("M0D.7: Transitive import reaches prohibited legacy dependency and missing import is visible", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "m0d-import-"));
    try {
      fs.writeFileSync(path.join(tempDir, "entry.js"), 'import "./middle.js";');
      fs.writeFileSync(path.join(tempDir, "middle.js"), 'export { load } from "./legacy.js";');
      fs.writeFileSync(path.join(tempDir, "legacy.js"), 'export const load = () => supabase.from("student_enrollments");');
      const traced = traceTransitiveLocalImports("entry.js", tempDir);
      assert.ok(traced.has(path.join(tempDir, "legacy.js")));
      assert.ok([...traced].some(file => fs.existsSync(file) && auditFileContent(file, fs.readFileSync(file, "utf8")).length));
      fs.writeFileSync(path.join(tempDir, "middle.js"), 'export { load } from "./missing.js";');
      const missing = traceTransitiveLocalImports("entry.js", tempDir);
      assert.ok(missing.has(path.join(tempDir, "missing.js")));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
