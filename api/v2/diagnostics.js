// api/v2/diagnostics.js
//
// Shop V2 diagnostics endpoint. Worker-secret gated (utils/v2-sync-worker.js
// → assertV2WorkerAuthorized). Returns the resolved V1/V2 runtime master
// switch (activeMode + killSwitch + source) and the per-flag configured /
// effective posture. Never leaks raw env values — only booleans + the mode
// token. Ported from LMS api/v2/diagnostics.js but trimmed to Shop's
// surface (no outbox/migrations/reconciliation — Shop is sync-source only).
//
// Methods: GET, POST. 405 otherwise. 401 when the worker secret is missing
// or mismatched.

import { assertV2WorkerAuthorized } from "../../utils/v2-sync-worker.js";
import { getRuntimeSnapshot } from "../../utils/v2-runtime-controller.js";
import {
  V2_FLAGS,
  isV2FlagConfigured,
  isV2FlagEnabled
} from "../../utils/v2-flags.js";

// Friendly flag keys → V2_FLAGS env names. `outboxShadow` is the one Shop
// actually wires (sync-helpers.js → isV2OutboxShadowMode). The rest are
// reported for parity with LMS so the admin UI can show posture.
const FLAG_KEYS = [
  ["outboxShadow", V2_FLAGS.OUTBOX_SHADOW_MODE],
  ["platformEnabled", V2_FLAGS.PLATFORM_ENABLED],
  ["driveWorkerDryRun", V2_FLAGS.DRIVE_WORKER_DRY_RUN],
  ["reconciliationReadonly", V2_FLAGS.RECONCILIATION_READONLY],
  ["globalOneDevice", V2_FLAGS.GLOBAL_ONE_DEVICE_ENABLED],
  ["corsAllowlist", V2_FLAGS.CORS_ALLOWLIST_ENABLED]
];

function buildFlagSnapshot() {
  const flags = {};
  for (const [friendly, envName] of FLAG_KEYS) {
    flags[friendly] = {
      envName,
      // `configured` = raw env flag (what the operator set), reported even
      // when the platform is in v1 so the admin can see posture.
      configured: isV2FlagConfigured(envName),
      // `effective` = behavioral state after the runtime gate. In v1 mode
      // every V2 feature reads as OFF regardless of its env flag.
      effective: isV2FlagEnabled(envName)
    };
  }
  return flags;
}

async function runShopV2Diagnostics() {
  // Resolve the runtime master switch once so the flag snapshot reports the
  // effective mode + per-flag configured/effective state consistently. Never
  // throws; degrades to a fail-closed v1 snapshot on DB error.
  const runtimeSnapshot = await getRuntimeSnapshot().catch(() => ({
    activeMode: "v1",
    killSwitch: false,
    ok: false,
    source: "diagnostics_error"
  }));

  return {
    ok: Boolean(runtimeSnapshot.ok),
    component: "shop",
    activeMode: runtimeSnapshot.activeMode,
    killSwitch: Boolean(runtimeSnapshot.killSwitch),
    source: runtimeSnapshot.source,
    flags: buildFlagSnapshot(),
    // Booleans only — never the raw secret values.
    secretsConfigured: {
      V2_WORKER_SECRET: !!process.env.V2_WORKER_SECRET,
      INTERNAL_SYNC_SECRET: !!process.env.INTERNAL_SYNC_SECRET
    },
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

    const result = await runShopV2Diagnostics();
    const status = result.ok ? 200 : 409;
    return res.status(status).json(result);
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      ok: false,
      component: "shop",
      error: status === 401 ? "Unauthorized" : "V2 diagnostics failed",
      message: status === 401 ? "Worker secret is invalid or missing." : String(error.message || error)
    });
  }
}

export { runShopV2Diagnostics, buildFlagSnapshot };
