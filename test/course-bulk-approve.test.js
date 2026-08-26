import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('pending course cards expose a course-scoped bulk approve action', () => {
  const ordersPage = read('orders.html');
  assert.match(ordersPage, /function renderPendingGrouped\(\)/);
  assert.match(ordersPage, /onclick="approveGroupAll\('\$\{courseSlug\}'\)"/);
  assert.match(ordersPage, /Duyệt Nhanh Lớp này/);
  assert.match(ordersPage, /o\.course === courseSlug && o\.status === "Chờ duyệt"/);
});

test('bulk approval only touches pending orders from the selected course', () => {
  const source = read('api/approve-all.js');
  assert.match(source, /\.eq\("course_slug", course\)/);
  assert.match(source, /\.eq\("status", "Chờ duyệt"\)/);
  assert.match(source, /filter\(order => order\.delivery_mode !== "telegram"\)/);
  assert.match(source, /\.eq\("status", "Chờ duyệt"\)\s*\.select/s);
});

test('one enrollment sync failure cannot stop the remaining bulk approvals', () => {
  const source = read('api/approve-all.js');
  assert.match(source, /for \(const order of updatedOrders\)/);
  assert.match(source, /catch \(syncErr\)/);
  assert.match(source, /results\.push\(\{ id: order\.id, ok: false/);
  assert.match(source, /syncSucceeded/);
  assert.match(source, /syncFailed: syncFailedCount/);
});

test('telegram-direct orders remain outside Commerce bulk approval', () => {
  const source = read('api/approve-all.js');
  assert.match(source, /skippedTelegram/);
  assert.match(source, /delivery_mode !== "telegram"/);
  assert.doesNotMatch(source, /telegram_invite_link\s*:/);
});
