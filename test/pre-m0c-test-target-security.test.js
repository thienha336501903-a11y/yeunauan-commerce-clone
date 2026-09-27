// test/pre-m0c-test-target-security.test.js
// Regression coverage for the isolated-target authority boundary.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  validateExplicitLoopbackTargetUrls,
  verifyPreM0cTestTargetIdentity
} from "./helpers/pre-m0c-test-target.js";

const original = {
  db: process.env.PRE_M0C_TEST_DATABASE_URL,
  supabase: process.env.PRE_M0C_TEST_SUPABASE_URL,
  identity: process.env.PRE_M0C_TEST_DB_IDENTITY_FILE
};

function restore() {
  process.env.PRE_M0C_TEST_DATABASE_URL = original.db;
  process.env.PRE_M0C_TEST_SUPABASE_URL = original.supabase;
  process.env.PRE_M0C_TEST_DB_IDENTITY_FILE = original.identity;
}

test("pre-M0C isolated target identity boundary", async (t) => {
  await t.test("remote database query parameter containing localhost is denied", () => {
    process.env.PRE_M0C_TEST_DATABASE_URL = "postgresql://user:pass@remote.example.com/db?note=localhost";
    process.env.PRE_M0C_TEST_SUPABASE_URL = original.supabase;
    assert.throws(() => validateExplicitLoopbackTargetUrls(), /loopback hostname/i);
    restore();
  });

  await t.test("remote database username containing localhost is denied", () => {
    process.env.PRE_M0C_TEST_DATABASE_URL = "postgresql://localhost-user:pass@remote.example.com/db";
    process.env.PRE_M0C_TEST_SUPABASE_URL = original.supabase;
    assert.throws(() => validateExplicitLoopbackTargetUrls(), /loopback hostname/i);
    restore();
  });

  await t.test("remote database path containing localhost is denied", () => {
    process.env.PRE_M0C_TEST_DATABASE_URL = "postgresql://user:pass@remote.example.com/localhost-db";
    process.env.PRE_M0C_TEST_SUPABASE_URL = original.supabase;
    assert.throws(() => validateExplicitLoopbackTargetUrls(), /loopback hostname/i);
    restore();
  });

  await t.test("loopback tunnel with wrong pinned PostgreSQL system_identifier is denied before guard creation", async () => {
    restore();
    const pinned = JSON.parse(fs.readFileSync(original.identity, "utf8"));
    const wrongFile = path.join(os.tmpdir(), `system-b-wrong-pre-m0c-identity-${process.pid}.json`);
    fs.writeFileSync(
      wrongFile,
      JSON.stringify({
        ...pinned,
        systemIdentifier: String(BigInt(String(pinned.systemIdentifier)) + 1n)
      }),
      { mode: 0o600 }
    );
    process.env.PRE_M0C_TEST_DB_IDENTITY_FILE = wrongFile;
    try {
      await assert.rejects(
        () => verifyPreM0cTestTargetIdentity({ requireGuardAbsent: true }),
        /system_identifier.*does not match pinned/i
      );
    } finally {
      fs.rmSync(wrongFile, { force: true });
      restore();
    }
  });

  await t.test("valid explicit local target matches independently pinned identity with no pre-existing guard", async () => {
    restore();
    const identity = await verifyPreM0cTestTargetIdentity({ requireGuardAbsent: true });
    assert.match(identity.systemIdentifier, /^\d+$/);
    assert.ok(identity.environmentFingerprint);
    assert.equal(identity.supabaseUrl, String(original.supabase).replace(/\/$/, ""));
  });
});

test.after(() => restore());
