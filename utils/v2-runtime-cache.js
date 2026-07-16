// utils/v2-runtime-cache.js
//
// Synchronous, in-process cache for the resolved V2 runtime mode. Kept in a
// tiny standalone module (no imports) so both `utils/v2-flags.js` (which the
// behavioral flag readers import) and `utils/v2-runtime-controller.js`
// (which does the async DB read) can share it WITHOUT a circular import.
//
// Semantics (the "restrict-only" master gate):
//   isV2ActiveCached() returns:
//     - true  when the cache is COLD (no snapshot yet) — fail-open so the
//             per-feature env flags control behavior exactly as before this
//             controller existed. This keeps V1 + existing tests unchanged.
//     - true  when the cached snapshot says activeMode='v2' and killSwitch
//             is off — the switch permits V2; per-feature env flags control.
//     - false when the cached snapshot says activeMode='v1' OR killSwitch
//             is on — the switch forces V1; every V2 behavioral feature is
//             OFF regardless of its env flag.
//
// The cache is populated by `warmRuntimeConfig()` / `refreshRuntimeConfig()`
// in v2-runtime-controller.js, which the request routers await once at the
// top of every request. A short TTL keeps one request consistent and avoids
// hammering the DB; the admin flip endpoint calls refresh() so the new mode
// is visible on that instance immediately, and other instances pick it up
// within the TTL.

let cachedSnapshot = null;
let cachedExpiresAt = 0;

export function getCachedSnapshot() {
  if (cachedSnapshot && Date.now() < cachedExpiresAt) {
    return cachedSnapshot;
  }
  // Expired — clear so a cold read is fail-open until the next warm.
  cachedSnapshot = null;
  return null;
}

export function setCachedSnapshot(snapshot, ttlMs) {
  cachedSnapshot = snapshot;
  cachedExpiresAt = Date.now() + (Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : 0);
}

export function clearCachedSnapshot() {
  cachedSnapshot = null;
  cachedExpiresAt = 0;
}

// The master gate. See module header for the fail-open-on-cold contract.
export function isV2ActiveCached() {
  const snap = getCachedSnapshot();
  if (!snap) return true; // cold → fail-open (env flags control)
  return snap.activeMode === "v2" && !snap.killSwitch;
}

// Test-only: force a snapshot so unit tests can exercise the v1/v2 gate
// without a DB. Reset with clearCachedSnapshot() (or _resetForTest()).
export function _setCachedSnapshotForTest(snapshot) {
  cachedSnapshot = snapshot;
  cachedExpiresAt = Date.now() + 60_000;
}

export function _resetForTest() {
  cachedSnapshot = null;
  cachedExpiresAt = 0;
}
