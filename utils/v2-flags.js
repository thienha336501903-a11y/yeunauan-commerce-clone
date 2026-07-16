const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);

// Restrict-only master gate. Re-exported here so behavioral flag readers can
// import it from the same module they already import their env-flag helpers
// from, without a second import. See utils/v2-runtime-controller.js +
// utils/v2-runtime-cache.js for the resolution + cache contract.
//
// Semantics:
//   - returns true (fail-open) when the runtime cache is COLD — i.e. before
//     the request router has awaited warmRuntimeConfig(). This keeps V1 and
//     existing tests unchanged: per-feature env flags control behavior.
//   - returns true when the resolved snapshot says activeMode='v2' and the
//     kill switch is off — the switch permits V2; per-feature env flags
//     still apply on top.
//   - returns false when the snapshot says activeMode='v1' or the kill
//     switch is on — the switch forces V1; every V2 behavioral feature is
//     OFF regardless of its env flag.
export { isV2ActiveCached } from './v2-runtime-cache.js';
import { isV2ActiveCached } from './v2-runtime-cache.js';

export const V2_FLAGS = Object.freeze({
  PLATFORM_ENABLED: 'V2_PLATFORM_ENABLED',
  OUTBOX_SHADOW_MODE: 'V2_OUTBOX_SHADOW_MODE',
  DRIVE_WORKER_DRY_RUN: 'V2_DRIVE_WORKER_DRY_RUN',
  RECONCILIATION_READONLY: 'V2_RECONCILIATION_READONLY',
  // RP2-B1 security flags (no V2_ prefix). Reported in diagnostics via the
  // GLOBAL_ONE_DEVICE_ENABLED / CORS_ALLOWLIST_ENABLED keys below so the
  // admin runtime-mode UI can show their configured + effective state.
  // Parity with LMS — Shop does not consume these yet but reports them.
  GLOBAL_ONE_DEVICE_ENABLED: 'V2_GLOBAL_ONE_DEVICE_ENABLED',
  CORS_ALLOWLIST_ENABLED: 'V2_CORS_ALLOWLIST_ENABLED',
});

export function getV2Env(name, fallback = '') {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim();
}

export function isV2FlagEnabled(name, fallback = false) {
  // Behavioral V2 features are restrict-only gated by the runtime master
  // switch. When the platform is in v1 (or the kill switch is on) every V2
  // feature reads as OFF regardless of its env flag, so flipping the admin
  // switch to V1 immediately withdraws all V2 behavior. Cold-cache is
  // fail-open (env flag controls) so V1 + existing tests are unchanged.
  if (!isV2ActiveCached()) return false;
  const value = getV2Env(name);
  if (!value) return fallback;
  return TRUE_VALUES.has(value.toLowerCase());
}

// Read-only inspection variant: returns the raw env flag value WITHOUT the
// runtime gate. Used by diagnostics/readiness to REPORT what is configured
// on the env (so the admin can see the flag posture) even when the platform
// is currently in v1. Behavioral code must use isV2FlagEnabled() (gated).
export function isV2FlagConfigured(name, fallback = false) {
  const value = getV2Env(name);
  if (!value) return fallback;
  return TRUE_VALUES.has(value.toLowerCase());
}

export function getV2ListFlag(name) {
  return getV2Env(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getV2RuntimeMode() {
  return getV2Env('V2_RUNTIME_MODE', isV2FlagEnabled(V2_FLAGS.PLATFORM_ENABLED) ? 'enabled' : 'off');
}

// ── RP2-A / RP2-B1 security flags (strict parser) ───────────────────────────
// Pure-function parser: only 1/true/yes/on (case-insensitive, trimmed) become
// true. Anything else (0/false/no/off/empty/undefined/non-string) is false.
// Never raises, never logs, never echoes the env value. Accepts an env-shaped
// object so tests can pass a snapshot without touching process.env.
export function parseBooleanFlag(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}

// RP2-A CORS allowlist flag. Kept separate from the one-device flag so the
// two features can be enabled independently. Gated by the runtime master
// switch (flipping to V1 disables the allowlist enforcement too); cold-cache
// is fail-open so V1 + existing tests are unchanged. Parity with LMS.
export function isV2CorsAllowlistEnabled(env = process.env) {
  if (!isV2ActiveCached()) return false;
  return parseBooleanFlag(env?.V2_CORS_ALLOWLIST_ENABLED);
}

// RP2-B1 global one-device / LMS verified-session enforcement. Parity with
// LMS. Shop does not consume this flag yet but reports it in diagnostics.
// When true, downstream systems treat every course as requiring a verified
// LMS session. When false (default), V1 behavior is preserved exactly.
//
// Gated by the runtime master switch: when the platform is in v1 mode (or
// the kill switch is on) this returns false regardless of the env flag, so
// flipping the switch back to V1 immediately restores V1 behavior even if
// V2_GLOBAL_ONE_DEVICE_ENABLED is still set on the env. Cold-cache is
// fail-open (env flag controls) so V1 + existing tests are unchanged.
export function isV2GlobalOneDeviceEnabled(env = process.env) {
  if (!isV2ActiveCached()) return false;
  return parseBooleanFlag(env?.V2_GLOBAL_ONE_DEVICE_ENABLED);
}

export const _internals = { parseBooleanFlag };
