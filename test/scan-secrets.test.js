// test/scan-secrets.test.js
// Regression test suite for Phase 9: Secret Scan Gate Fix
// Verifies:
// 1. env reference only => allowed
// 2. env reference + literal secret same line => FAIL
// 3. hardcoded x-vercel-protection-bypass => FAIL
// 4. invalid Git base => FAIL
// 5. placeholder/example that matches approved pattern => PASS
// 6. secret output value never printed

import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function runScannerWithText(text) {
  const tempFile = path.join(process.cwd(), "test-temp-scan.txt");
  fs.writeFileSync(tempFile, text, "utf8");
  try {
    const stdout = execSync(`python scripts/scan-secrets.py "${tempFile}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status || 1, stdout: (err.stdout || "") + (err.stderr || "") };
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

test("PHASE 9.1: env reference only is allowed", () => {
  const input = `
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bypassToken = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  `;
  const res = runScannerWithText(input);
  assert.equal(res.code, 0, `Expected PASS, got code ${res.code}: ${res.stdout}`);
  assert.ok(res.stdout.includes("PASS: No secret patterns detected"));
});

test("PHASE 9.2: env reference + literal secret on same line FAILS", () => {
  const input = `
    const secret = process.env.API_SECRET || "service_role_secret_value_1234567890abcdef123456";
  `;
  const res = runScannerWithText(input);
  assert.equal(res.code, 1, "Must fail when literal secret is on the same line as process.env");
  assert.ok(res.stdout.includes("[ALERT] Secret patterns detected"));
  // Assert secret value is NEVER printed in output
  assert.ok(!res.stdout.includes("service_role_secret_value_1234567890abcdef123456"));
});

test("PHASE 9.3: hardcoded x-vercel-protection-bypass FAILS", () => {
  const input = `
    const headers = { "x-vercel-protection-bypass": "abcdef0123456789abcdef" };
  `;
  const res = runScannerWithText(input);
  assert.equal(res.code, 1, "Must fail on x-vercel-protection-bypass header");
  assert.ok(res.stdout.includes("Vercel Protection Bypass Header Value"));
  assert.ok(!res.stdout.includes("abcdef0123456789abcdef"));
});

test("PHASE 9.4: invalid Git base FAILS scanner with nonzero exit code", () => {
  try {
    execSync("python scripts/scan-secrets.py --diff nonexistent_git_base_hash_99999", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    assert.fail("Should have failed for nonexistent base ref");
  } catch (err) {
    assert.equal(err.status, 1);
    const output = (err.stdout || "") + (err.stderr || "");
    assert.ok(output.includes("FAILED: Git diff execution error"));
  }
});

test("PHASE 9.5: approved placeholder matches PASS", () => {
  const input = `
    const dummyJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy";
    const authHeader = "Bearer valid_jwt";
    const testPass = "P@ssw0rd_123";
  `;
  const res = runScannerWithText(input);
  assert.equal(res.code, 0, `Expected PASS for approved test fixtures, got: ${res.stdout}`);
  assert.ok(res.stdout.includes("PASS: No secret patterns detected"));
});

test("PHASE 9.6: Secret output value is NEVER printed in findings", () => {
  const secretLiteral = "sbp_abcdef01234567890123456789abcdef";
  const input = `
    const pat = "${secretLiteral}";
  `;
  const res = runScannerWithText(input);
  assert.equal(res.code, 1);
  // Ensure the secret literal string does NOT appear anywhere in scanner stdout/stderr
  assert.equal(res.stdout.includes(secretLiteral), false, "Secret literal must never be printed to stdout");
  assert.ok(res.stdout.includes("Supabase Personal Access Token"));
});
