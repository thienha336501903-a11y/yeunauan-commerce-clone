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

test('bulk approval only touches pending non-Telegram orders from the selected course', () => {
  const source = read('api/approve-all.js');
  assert.match(source, /String\(req\.body\?\.course \|\| ""\)\.trim\(\)/);
  assert.match(source, /\.eq\("course_slug", course\)/);
  assert.match(source, /\.eq\("status", "Chờ duyệt"\)/);
  assert.match(source, /filter\(order => String\(order\.delivery_mode \|\| ''\)\.toLowerCase\(\) !== "telegram"\)/);
  assert.match(source, /\.in\("id", standardOrders\.map\(order => order\.id\)\)[\s\S]*\.eq\("status", "Chờ duyệt"\)[\s\S]*\.select/);
});

test('V5 bulk approval is sync-first and one failure cannot stop remaining orders', () => {
  const source = read('api/approve-all.js');
  assert.match(source, /for \(const order of v5Orders\)/);
  assert.match(source, /await approveV5Order\(order\)/);
  assert.match(source, /keptPending: true/);
  assert.match(source, /catch \(syncErr\)/);
  assert.match(source, /syncSucceeded/);
  assert.match(source, /syncFailed: syncFailedCount/);
});

test('legacy and V4 bulk sync remains isolated after V5 approvals', () => {
  const source = read('api/approve-all.js');
  assert.match(source, /for \(const order of updatedStandardOrders\)/);
  assert.match(source, /syncV4EnrollmentToLms\(order, "create"\)/);
  assert.match(source, /syncEnrollmentToExternalSystems\(order, "create"\)/);
});

test('telegram-direct orders remain outside Commerce bulk approval', () => {
  const source = read('api/approve-all.js');
  assert.match(source, /skippedTelegram/);
  assert.match(source, /String\(order\.delivery_mode \|\| ''\)\.toLowerCase\(\) !== "telegram"/);
  assert.doesNotMatch(source, /telegram_invite_link\s*:/);
});
