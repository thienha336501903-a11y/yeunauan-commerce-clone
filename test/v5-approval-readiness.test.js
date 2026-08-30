import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const orders = fs.readFileSync(new URL('../api/orders.js', import.meta.url), 'utf8');
const bulk = fs.readFileSync(new URL('../api/approve-all.js', import.meta.url), 'utf8');
const approval = fs.readFileSync(new URL('../utils/v5-order-approval.js', import.meta.url), 'utf8');

test('single V5 approval delegates to the sync-first helper before generic order update', () => {
  const v5Block = orders.match(/if \(deliveryMode === 'v5' && status !== undefined && status !== existingOrder\.status\) \{([\s\S]*?)\n      \}/)?.[1] || '';
  assert.match(v5Block, /status === 'Đã duyệt'/);
  assert.match(v5Block, /await approveV5Order\(orderForSync, updateData\)/);
  assert.match(v5Block, /return res\.status\(result\.statusCode \|\| 409\)/);
  assert.match(approval, /const gate = await v5ApprovalReadiness\(order\)/);
  assert.match(approval, /if \(!gate\.ok\) return \{ \.\.\.gate, statusCode: 409 \}/);
});

test('bulk V5 approval evaluates canonical readiness per order and never mass-approves V5 rows first', () => {
  assert.match(bulk, /for \(const order of v5Orders\)/);
  assert.match(bulk, /await approveV5Order\(order\)/);
  assert.match(bulk, /keptPending: true/);
  const standardMassUpdate = bulk.indexOf('.in("id", standardOrders.map(order => order.id))');
  const v5Loop = bulk.indexOf('for (const order of v5Orders)');
  assert.ok(v5Loop >= 0 && standardMassUpdate > v5Loop);
});

test('V5 revoke and resync use dedicated helpers instead of the new-sale readiness path', () => {
  assert.match(orders, /if \(action === 'resync'\)[\s\S]*deliveryMode === 'v5'[\s\S]*resyncV5Order\(existingOrder\)/);
  assert.match(orders, /existingOrder\.status === 'Đã duyệt'[\s\S]*revokeV5Order\(existingOrder, status, updateData\)/);
  assert.match(approval, /v5ExistingAccessReadiness\(order\)/);
  assert.match(approval, /const action = approved \? 'restore' : 'revoke'/);
});
