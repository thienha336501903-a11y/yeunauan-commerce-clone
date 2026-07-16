// tests/v2-diagnostics.test.mjs
//
// Acceptance tests for the Shop V2 diagnostics + readiness endpoints
// (api/v2/diagnostics.js, api/v2/readiness.js). node:test, no real DB.
// Uses the controller's test seam (`globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__`)
// so getRuntimeSnapshot resolves without a DB.
//
// Contract under test:
//   - no worker secret → 401 (both endpoints, GET + POST)
//   - wrong worker secret → 401
//   - valid worker secret → 200 with activeMode + component:"shop"
//   - 405 for non-GET/POST/OPTIONS methods
//   - no raw env value leak in any response (only booleans + mode token)

import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.VERCEL_ENV = process.env.VERCEL_ENV || "test";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://v2diag-shop-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "v2diag-shop-test-service-role-key";

const controller = await import("../utils/v2-runtime-controller.js");

const SECRET_ENV_KEYS = ["V2_WORKER_SECRET", "INTERNAL_SYNC_SECRET"];
const FLAG_ENV_KEYS = [
  "V2_OUTBOX_SHADOW_MODE",
  "V2_PLATFORM_ENABLED",
  "V2_GLOBAL_ONE_DEVICE_ENABLED",
  "V2_CORS_ALLOWLIST_ENABLED"
];
const OVERRIDE_ENV_KEYS = ["V2_RUNTIME_FORCE_MODE", "V2_RUNTIME_FORCE_KILL", "V2_RUNTIME_CACHE_TTL_MS"];

function snapshotEnv() {
  const s = {};
  for (const k of [...SECRET_ENV_KEYS, ...FLAG_ENV_KEYS, ...OVERRIDE_ENV_KEYS]) s[k] = process.env[k];
  return s;
}
function restoreEnv(s) {
  for (const k of [...SECRET_ENV_KEYS, ...FLAG_ENV_KEYS, ...OVERRIDE_ENV_KEYS]) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}
function clearEnv() {
  for (const k of [...SECRET_ENV_KEYS, ...FLAG_ENV_KEYS, ...OVERRIDE_ENV_KEYS]) delete process.env[k];
}

function resetController() {
  controller._resetRuntimeControllerCache();
  delete globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__;
  delete globalThis.__V2_RUNTIME_STUB_DB__;
}

function mockRes() {
  const r = { statusCode: null, headers: {}, jsonBody: null, ended: false };
  r.status = (code) => { r.statusCode = code; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.json = (body) => { r.jsonBody = body; r.ended = true; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}
function mockReq({ method = "GET", headers = {}, body = {}, query = {} } = {}) {
  return { method, headers, body, query, socket: {} };
}

// Cache-bust so each load sees the current process.env (warmRuntimeConfig
// imports supabase which reads env at module load).
async function loadHandler(path) {
  return (await import(`${path}?t=${Date.now()}`)).default;
}

// ── 401: no secret ────────────────────────────────────────────────────────

test("diagnostics: GET with no worker secret → 401, no leak", async () => {
  const snap = snapshotEnv();
  clearEnv();
  resetController();
  try {
    const handler = await loadHandler("../api/v2/diagnostics.js");
    const res = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.jsonBody?.ok, false);
    assert.equal(res.jsonBody?.component, "shop");
    // No activeMode / source / flags leaked on auth failure.
    assert.equal("activeMode" in (res.jsonBody || {}), false);
    assert.equal("flags" in (res.jsonBody || {}), false);
  } finally {
    resetController();
    restoreEnv(snap);
  }
});

test("readiness: POST with no worker secret → 401, no leak", async () => {
  const snap = snapshotEnv();
  clearEnv();
  resetController();
  try {
    const handler = await loadHandler("../api/v2/readiness.js");
    const res = mockRes();
    await handler(mockReq({ method: "POST" }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.jsonBody?.ok, false);
    assert.equal("activeMode" in (res.jsonBody || {}), false);
  } finally {
    resetController();
    restoreEnv(snap);
  }
});

test("diagnostics: wrong worker secret → 401", async () => {
  const snap = snapshotEnv();
  clearEnv();
  process.env.V2_WORKER_SECRET = "correct-secret";
  resetController();
  try {
    const handler = await loadHandler("../api/v2/diagnostics.js");
    const res = mockRes();
    await handler(
      mockReq({ method: "GET", headers: { "x-v2-worker-secret": "wrong-secret" } }),
      res
    );
    assert.equal(res.statusCode, 401);
  } finally {
    resetController();
    restoreEnv(snap);
  }
});

test("diagnostics: x-sync-secret fallback header works when V2_WORKER_SECRET unset", async () => {
  const snap = snapshotEnv();
  clearEnv();
  process.env.INTERNAL_SYNC_SECRET = "shared-sync-secret";
  resetController();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    const handler = await loadHandler("../api/v2/diagnostics.js");
    const res = mockRes();
    await handler(
      mockReq({ method: "GET", headers: { "x-sync-secret": "shared-sync-secret" } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonBody?.component, "shop");
    assert.equal(res.jsonBody?.activeMode, "v2");
  } finally {
    resetController();
    restoreEnv(snap);
  }
});

// ── 200: valid secret ──────────────────────────────────────────────────────

test("diagnostics: valid secret → 200 with activeMode + component:shop + flags", async () => {
  const snap = snapshotEnv();
  clearEnv();
  process.env.V2_WORKER_SECRET = "correct-secret";
  resetController();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    const handler = await loadHandler("../api/v2/diagnostics.js");
    const res = mockRes();
    await handler(
      mockReq({ method: "GET", headers: { "x-v2-worker-secret": "correct-secret" } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonBody?.ok, true);
    assert.equal(res.jsonBody?.component, "shop");
    assert.equal(res.jsonBody?.activeMode, "v2");
    assert.equal(res.jsonBody?.killSwitch, false);
    assert.equal(res.jsonBody?.source, "stub");
    // flags posture present with configured + effective per friendly key
    assert.ok(res.jsonBody?.flags && typeof res.jsonBody.flags === "object");
    assert.ok("outboxShadow" in res.jsonBody.flags);
    assert.ok("globalOneDevice" in res.jsonBody.flags);
    assert.ok("corsAllowlist" in res.jsonBody.flags);
    assert.equal(res.jsonBody.flags.outboxShadow.configured, false);
    assert.equal(res.jsonBody.flags.outboxShadow.effective, false);
    // secretsConfigured booleans only
    assert.equal(res.jsonBody.secretsConfigured.V2_WORKER_SECRET, true);
  } finally {
    resetController();
    restoreEnv(snap);
  }
});

test("diagnostics: v1 snapshot → effective flags OFF even when env flag configured", async () => {
  const snap = snapshotEnv();
  clearEnv();
  process.env.V2_WORKER_SECRET = "correct-secret";
  process.env.V2_OUTBOX_SHADOW_MODE = "true"; // configured on, but mode v1 → effective off
  resetController();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v1", killSwitch: false };
  try {
    const handler = await loadHandler("../api/v2/diagnostics.js");
    const res = mockRes();
    await handler(
      mockReq({ method: "POST", headers: { "x-v2-worker-secret": "correct-secret" } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonBody?.activeMode, "v1");
    assert.equal(res.jsonBody?.flags?.outboxShadow?.configured, true);
    assert.equal(res.jsonBody?.flags?.outboxShadow?.effective, false);
  } finally {
    resetController();
    restoreEnv(snap);
  }
});

test("readiness: valid secret → 200 with activeMode + supabaseConfigured", async () => {
  const snap = snapshotEnv();
  clearEnv();
  process.env.V2_WORKER_SECRET = "correct-secret";
  process.env.SUPABASE_URL = "https://v2ready-shop-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "v2ready-shop-test-service-role-key";
  resetController();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    const handler = await loadHandler("../api/v2/readiness.js");
    const res = mockRes();
    await handler(
      mockReq({ method: "GET", headers: { "x-v2-worker-secret": "correct-secret" } }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonBody?.ok, true);
    assert.equal(res.jsonBody?.component, "shop");
    assert.equal(res.jsonBody?.activeMode, "v2");
    assert.equal(res.jsonBody?.supabaseConfigured, true);
  } finally {
    resetController();
    restoreEnv(snap);
  }
});

// ── 405 ────────────────────────────────────────────────────────────────────

test("diagnostics: PUT → 405 (before auth, so no secret needed)", async () => {
  const snap = snapshotEnv();
  clearEnv();
  resetController();
  try {
    const handler = await loadHandler("../api/v2/diagnostics.js");
    const res = mockRes();
    await handler(mockReq({ method: "PUT" }), res);
    assert.equal(res.statusCode, 405);
  } finally {
    resetController();
    restoreEnv(snap);
  }
});

test("readiness: DELETE → 405", async () => {
  const snap = snapshotEnv();
  clearEnv();
  resetController();
  try {
    const handler = await loadHandler("../api/v2/readiness.js");
    const res = mockRes();
    await handler(mockReq({ method: "DELETE" }), res);
    assert.equal(res.statusCode, 405);
  } finally {
    resetController();
    restoreEnv(snap);
  }
});

// ── no raw env leak ─────────────────────────────────────────────────────────

test("diagnostics: response never leaks raw env secret values", async () => {
  const snap = snapshotEnv();
  clearEnv();
  process.env.V2_WORKER_SECRET = "raw-secret-value-must-not-leak-xyz";
  process.env.INTERNAL_SYNC_SECRET = "raw-internal-sync-must-not-leak-abc";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "raw-service-role-must-not-leak-999";
  resetController();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    const handler = await loadHandler("../api/v2/diagnostics.js");
    const res = mockRes();
    await handler(
      mockReq({ method: "GET", headers: { "x-v2-worker-secret": "raw-secret-value-must-not-leak-xyz" } }),
      res
    );
    const text = JSON.stringify(res.jsonBody || {});
    for (const forbidden of [
      "raw-secret-value-must-not-leak-xyz",
      "raw-internal-sync-must-not-leak-abc",
      "raw-service-role-must-not-leak-999"
    ]) {
      assert.equal(text.includes(forbidden), false, `response leaked ${forbidden}`);
    }
    // secretsConfigured keys are booleans only
    assert.equal(typeof res.jsonBody.secretsConfigured.V2_WORKER_SECRET, "boolean");
  } finally {
    resetController();
    restoreEnv(snap);
  }
});

test("readiness: response never leaks raw env secret values", async () => {
  const snap = snapshotEnv();
  clearEnv();
  process.env.V2_WORKER_SECRET = "raw-secret-readiness-must-not-leak";
  process.env.SUPABASE_URL = "https://v2leak-shop-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "raw-service-role-readiness-must-not-leak";
  resetController();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    const handler = await loadHandler("../api/v2/readiness.js");
    const res = mockRes();
    await handler(
      mockReq({ method: "GET", headers: { "x-v2-worker-secret": "raw-secret-readiness-must-not-leak" } }),
      res
    );
    const text = JSON.stringify(res.jsonBody || {});
    for (const forbidden of [
      "raw-secret-readiness-must-not-leak",
      "raw-service-role-readiness-must-not-leak"
    ]) {
      assert.equal(text.includes(forbidden), false, `response leaked ${forbidden}`);
    }
  } finally {
    resetController();
    restoreEnv(snap);
  }
});

// ── OPTIONS preflight ──────────────────────────────────────────────────────

test("diagnostics: OPTIONS → 200 preflight (no auth needed)", async () => {
  const snap = snapshotEnv();
  clearEnv();
  resetController();
  try {
    const handler = await loadHandler("../api/v2/diagnostics.js");
    const res = mockRes();
    await handler(mockReq({ method: "OPTIONS" }), res);
    assert.equal(res.statusCode, 200);
  } finally {
    resetController();
    restoreEnv(snap);
  }
});
