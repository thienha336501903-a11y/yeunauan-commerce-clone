export const DELIVERY_MODES = Object.freeze(['lms', 'telegram', 'v4', 'v5']);

export function parseDeliveryMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return DELIVERY_MODES.includes(normalized) ? normalized : null;
}

export function requireDeliveryMode(value) {
  const parsed = parseDeliveryMode(value);
  if (!parsed) {
    const error = new Error('Hình thức học không hợp lệ');
    error.code = 'invalid_delivery_mode';
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

export function normalizeDeliveryMode(value) {
  return parseDeliveryMode(value) || 'lms';
}

export function deliveryPolicy(value) {
  const mode = normalizeDeliveryMode(value);
  return Object.freeze({
    mode,
    requiresEmail: mode !== 'telegram',
    requiresTelegramUsername: mode === 'telegram',
    createsLmsEnrollment: mode !== 'telegram',
    createsTelegramInvite: mode === 'telegram',
    learningTarget: mode === 'telegram' ? 'telegram' : (mode === 'v5' ? 'v5' : (mode === 'v4' ? 'v4' : 'lms'))
  });
}
