import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDeliveryMode, parseDeliveryMode, requireDeliveryMode } from '../utils/delivery-policy.js';

test('strict admin-write validator rejects blank or unsupported delivery mode', () => {
  assert.equal(requireDeliveryMode('v5'), 'v5');
  assert.equal(requireDeliveryMode(' V4 '), 'v4');
  assert.throws(() => requireDeliveryMode(''), error => error?.code === 'invalid_delivery_mode' && error?.statusCode === 400);
  assert.throws(() => requireDeliveryMode('v5x'), error => error?.code === 'invalid_delivery_mode' && error?.statusCode === 400);
});

test('tolerant normalization remains available only for legacy/read compatibility', () => {
  assert.equal(parseDeliveryMode('v5'), 'v5');
  assert.equal(parseDeliveryMode('unknown'), null);
  assert.equal(normalizeDeliveryMode(undefined), 'lms');
  assert.equal(normalizeDeliveryMode('unknown'), 'lms');
  assert.equal(normalizeDeliveryMode('telegram'), 'telegram');
});
