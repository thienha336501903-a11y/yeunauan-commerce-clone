const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);

export const V2_FLAGS = Object.freeze({
  PLATFORM_ENABLED: 'V2_PLATFORM_ENABLED',
  OUTBOX_SHADOW_MODE: 'V2_OUTBOX_SHADOW_MODE',
  DRIVE_WORKER_DRY_RUN: 'V2_DRIVE_WORKER_DRY_RUN',
  RECONCILIATION_READONLY: 'V2_RECONCILIATION_READONLY',
});

export function getV2Env(name, fallback = '') {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim();
}

export function isV2FlagEnabled(name, fallback = false) {
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
