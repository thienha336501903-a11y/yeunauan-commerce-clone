// api/v2/readiness.js
//
// Shop V2 readiness endpoint. Worker-secret gated (utils/v2-sync-worker.js
// → assertV2WorkerAuthorized). Returns a basic readiness object: ok flag,
// the resolved activeMode, and that the supabase client is configured.
// Ported from LMS api/v2/readiness.js but trimmed to Shop's surface (no
// migrations/outbox/reconciliation gates — Shop is sync-source only).
//
// Methods: GET, POST. 405 otherwise. 401 when the worker secret is missing
// or mismatched.

import { assertV2WorkerAuthorized } from "../../utils/v2-sync-worker.js";
import { getRuntimeSnapshot } from "../../utils/v2-runtime-controller.js";

async function runShopV2Readiness() {
  // Resolve the runtime master switch once. Never throws; degrades to a
  // fail-closed v1 snapshot on DB error.
  const runtimeSnapshot = await getRuntimeSnapshot().catch(() => ({
    activeMode: "v1",
    killSwitch: false,
    ok: false,
    source: "readiness_error"
  }));

  // The supabase client is configured when both env vars are present. We do
  // NOT issue a DB query here (readiness is cheap + non-invasive); the
  // diagnostics endpoint is the deeper probe.
  const supabaseConfigured = Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const ok = Boolean(runtimeSnapshot.ok) && supabaseConfigured;

  return {
    ok,
    component: "shop",
    activeMode: runtimeSnapshot.activeMode,
    killSwitch: Boolean(runtimeSnapshot.killSwitch),
    source: runtimeSnapshot.source,
    supabaseConfigured,
    generatedAt: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-v2-worker-secret, x-sync-secret");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    assertV2WorkerAuthorized(req);

    const result = await runShopV2Readiness();
    const status = result.ok ? 200 : 409;
    return res.status(status).json(result);
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      ok: false,
      component: "shop",
      error: status === 401 ? "Unauthorized" : "V2 readiness check failed",
      message: status === 401 ? "Worker secret is invalid or missing." : String(error.message || error)
    });
  }
}

export { runShopV2Readiness };
