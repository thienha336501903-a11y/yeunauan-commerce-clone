import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const helper = fs.readFileSync(new URL('../utils/v5-order-approval.js', import.meta.url), 'utf8');
const orders = fs.readFileSync(new URL('../api/orders.js', import.meta.url), 'utf8');
const bulk = fs.readFileSync(new URL('../api/approve-all.js', import.meta.url), 'utf8');

test('V5 approval creates entitlement before writing Đã duyệt', () => {
  const syncIndex = helper.indexOf("syncV5EnrollmentToLms(order, 'create')");
  const orderIndex = helper.indexOf("status: 'Đã duyệt'");
  assert.ok(syncIndex >= 0 && orderIndex > syncIndex);
  assert.match(helper, /if \(v5SyncFailed\(syncResults\)\)[\s\S]*persistSyncState/);
});

test('failed V5 order commit compensates only its exact source-order entitlement', () => {
  assert.match(helper, /syncV5EnrollmentToLms\(order, 'revoke'\)/);
  assert.match(helper, /v5_order_commit_failed/);
});

test('single V5 status changes use sync-first helper instead of legacy post-write sync', () => {
  assert.match(orders, /approveV5Order\(orderForSync, updateData\)/);
  assert.match(orders, /revokeV5Order\(existingOrder, status, updateData\)/);
  assert.match(orders, /deliveryMode !== 'v5'/);
  assert.match(orders, /v5_approved_email_locked/);
});

test('bulk V5 approval keeps failed entitlements pending while leaving V4 and legacy isolated', () => {
  assert.match(bulk, /for \(const order of v5Orders\)/);
  assert.match(bulk, /approveV5Order\(order\)/);
  assert.match(bulk, /keptPending: true/);
  assert.match(bulk, /standardOrders/);
});
