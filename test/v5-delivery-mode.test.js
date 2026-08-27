import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const policy = read('utils/delivery-policy.js');
const syncHelpers = read('utils/sync-helpers.js');
const v5Sync = read('utils/v5-sync-helpers.js');
const register = read('api/register.js');
const config = read('api/config.js');
const orders = read('api/orders.js');
const approveAll = read('api/approve-all.js');
const v5Admin = read('v5-courses.html');

test('delivery policy recognizes V5 as email/enrollment LMS target', () => {
  assert.match(policy, /\['lms', 'telegram', 'v4', 'v5'\]/);
  assert.match(policy, /mode === 'v5' \? 'v5' : 'lms'/);
  assert.match(policy, /requiresEmail: mode !== 'telegram'/);
});

test('V5 sync is isolated from legacy Portal and uses dedicated LMS endpoint', () => {
  assert.match(syncHelpers, /delivery_mode \|\| orderData\?\.deliveryMode[\s\S]*=== 'v5'/);
  assert.match(syncHelpers, /syncV5EnrollmentToLms/);
  assert.match(v5Sync, /\/api\/v5-sync/);
  assert.match(v5Sync, /portal: 'SKIPPED_V5'/);
  assert.match(v5Sync, /action: actionType === 'create' \? 'syncEnrollment' : 'revokeEnrollment'/);
});

test('V5 cannot accept registration before content publish gate', () => {
  assert.match(register, /deliveryMode === 'v5' && courseRec\.is_published !== true/);
  assert.match(register, /sync_portal_status = 'SKIPPED_V5'/);
  assert.match(register, /runtime\.lmsPublicUrl[\s\S]*my-courses\.html\?registered=1/);
});

test('V5 admin creates safe draft and requires published content before sale', () => {
  assert.match(config, /delivery_mode: 'v5'/);
  assert.match(config, /active: false/);
  assert.match(config, /is_published: false/);
  assert.match(config, /status: 'draft'/);
  assert.match(config, /action === 'openLearningGate'/);
  assert.match(config, /V5 phải Publish nội dung và mở cổng học trước khi bật bán/);
  assert.match(v5Admin, /Tạo khóa Draft → soạn như Telegram → Publish → mở cổng học → bật bán/);
});

test('single and bulk approvals keep explicit V5 branches', () => {
  assert.match(orders, /if \(mode === 'v5'\) return syncV5EnrollmentToLms\(order, actionType\)/);
  assert.match(orders, /syncV5EnrollmentToLms/);
  assert.match(approveAll, /else if \(mode === "v5"\) syncResults = await syncV5EnrollmentToLms\(order, "create"\)/);
  assert.match(approveAll, /SKIPPED_V5/);
});
