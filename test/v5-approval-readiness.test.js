import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const orders = fs.readFileSync(new URL('../api/orders.js', import.meta.url), 'utf8');
const bulk = fs.readFileSync(new URL('../api/approve-all.js', import.meta.url), 'utf8');

test('single V5 approval checks canonical readiness before writing Đã duyệt', () => {
  const gateIndex = orders.indexOf("status === 'Đã duyệt'");
  const updateIndex = orders.indexOf("const { data, error } = await supabase.from('orders').update(updateData)");
  assert.ok(gateIndex >= 0 && updateIndex > gateIndex);
  assert.match(orders, /v5ApprovalReadiness\(existingOrder\)/);
  assert.match(orders, /getV5Readiness\(course\.id\)/);
  assert.match(orders, /return res\.status\(409\)/);
});

test('bulk V5 approval checks one canonical course gate before mass status update', () => {
  const gateIndex = bulk.indexOf('ensureBulkV5Ready(course, enrollmentOrders)');
  const updateIndex = bulk.indexOf('.update({ status: "Đã duyệt"');
  assert.ok(gateIndex >= 0 && updateIndex > gateIndex);
  assert.match(bulk, /getV5Readiness\(course\.id\)/);
  assert.match(bulk, /return res\.status\(409\)/);
});

test('V5 revoke/resync paths are not blocked by the pre-approval readiness gate', () => {
  const resyncIndex = orders.indexOf("if (action === 'resync')");
  const approvalIndex = orders.indexOf("status === 'Đã duyệt'");
  assert.ok(resyncIndex >= 0 && approvalIndex > resyncIndex);
  assert.match(orders, /actionType = existingOrder\.status === 'Đã duyệt' \? 'create' : 'revoke'/);
});
