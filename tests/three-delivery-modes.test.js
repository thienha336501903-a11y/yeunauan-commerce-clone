import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DELIVERY_MODES, deliveryPolicy, normalizeDeliveryMode } from '../utils/delivery-policy.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('delivery behavior table stays explicit for all three modes', () => {
  assert.deepEqual(DELIVERY_MODES, ['lms', 'telegram', 'v4']);
  assert.deepEqual(deliveryPolicy('lms'), {
    mode: 'lms', requiresEmail: true, requiresTelegramUsername: false,
    createsLmsEnrollment: true, createsTelegramInvite: false, learningTarget: 'lms'
  });
  assert.deepEqual(deliveryPolicy('telegram'), {
    mode: 'telegram', requiresEmail: false, requiresTelegramUsername: true,
    createsLmsEnrollment: false, createsTelegramInvite: true, learningTarget: 'telegram'
  });
  assert.deepEqual(deliveryPolicy('v4'), {
    mode: 'v4', requiresEmail: true, requiresTelegramUsername: false,
    createsLmsEnrollment: true, createsTelegramInvite: false, learningTarget: 'v4'
  });
  assert.equal(normalizeDeliveryMode('unexpected-client-value'), 'lms');
});

test('V4 checkout is fail-closed until content is published', () => {
  const register = read('api/register.js');
  const config = read('api/config.js');
  assert.match(register, /courseRec\.raw_data\?\.v4SellBeforePublishAcknowledged !== true/);
  assert.match(config, /rawData\.v4SellBeforePublishAcknowledged !== true/);
  assert.match(register, /policy\.requiresEmail/);
  assert.match(register, /if \(deliveryMode === 'telegram'\) \{[\s\S]*createOrderInvite/);
});

test('bulk approval preserves Telegram bot authority and dispatches V4 separately', () => {
  const bulk = read('api/approve-all.js');
  assert.match(bulk, /filter\(order => order\.delivery_mode !== "telegram"\)/);
  assert.match(bulk, /syncV4EnrollmentToLms/);
  assert.match(bulk, /skippedTelegram/);
});

test('Commerce sends V4 order correlation and never deletes mapping implicitly', () => {
  const helper = read('utils/v4-sync-helpers.js');
  const courses = read('api/courses.js');
  assert.match(helper, /orderId: String\(orderData\.id/);
  assert.match(helper, /deliveryMode: 'v4'/);
  assert.match(courses, /Không thể xóa khóa đang có liên kết dữ liệu/);
  const deleteBlock = courses.slice(courses.indexOf("if (req.method === 'DELETE')", courses.indexOf('export default')));
  assert.doesNotMatch(deleteBlock, /lms_v4_telegram_course_sources'\)\.delete/);
});

test('Admin supports a post link, automatic slug and separate content/sale states', () => {
  const admin = read('admin.html');
  assert.match(admin, /Học trên LMS cũ/);
  assert.match(admin, /Nhận bài qua Telegram/);
  assert.match(admin, /Học trên LMS V4/);
  assert.match(admin, /id="v4TelegramPostLinkInput"/);
  assert.match(admin, /function slugifyCourse/);
  assert.match(admin, /Nội dung: \$\{isPublished \? 'Đã Publish' : 'Draft'\}/);
  assert.match(admin, /Bán: \$\{active \? 'Đang bán' : 'Đã tắt'\}/);
});
