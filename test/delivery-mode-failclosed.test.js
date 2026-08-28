import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDeliveryMode, parseDeliveryMode } from '../utils/delivery-policy.js';

test('delivery mode parsing never degrades an explicit unknown mode to legacy LMS', () => {
  assert.equal(parseDeliveryMode('v5'), 'v5');
  assert.equal(parseDeliveryMode(' V4 '), 'v4');
  assert.equal(parseDeliveryMode(''), null);
  assert.equal(parseDeliveryMode('v5x'), null);
  assert.throws(
    () => normalizeDeliveryMode('v5x'),
    error => error?.code === 'invalid_delivery_mode' && /v5x/.test(error.message)
  );
});

test('an omitted delivery mode keeps the legacy-compatible default only for true omission', () => {
  assert.equal(normalizeDeliveryMode(undefined), 'lms');
  assert.equal(normalizeDeliveryMode(null), 'lms');
  assert.equal(normalizeDeliveryMode(''), 'lms');
  assert.equal(normalizeDeliveryMode('telegram'), 'telegram');
  assert.equal(normalizeDeliveryMode('v4'), 'v4');
  assert.equal(normalizeDeliveryMode('v5'), 'v5');
});
