import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractCloudinaryBillPublicId } from '../utils/cloudinary-public-id.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const checkout = read('index.html');
assert.match(checkout, /redirecting to V4 course manager/);
assert.match(checkout, /my-courses\.html\?registered=1&course=/);
assert.doesNotMatch(checkout, /redirecting to V4 Web entry/);

const register = read('api/register.js');
assert.match(register, /sync_portal_status = 'SKIPPED_V4'/);
assert.match(register, /deliveryMode === 'lms'/);
assert.match(register, /my-courses\.html\?registered=1&course=/);
assert.match(register, /billPublicId: uploadResult\.public_id/);

const courses = read('api/courses.js');
assert.match(courses, /requestAction === 'v4-sources'/);
assert.match(courses, /handleV4Sources/);
assert.match(courses, /validateV4ReadySource/);
assert.match(courses, /lms_v4_telegram_course_sources/);
assert.match(courses, /tgcloner_source_messages/);
assert.match(courses, /count: 'exact'/);
assert.match(courses, /syncV4CourseToLms/);
assert.match(courses, /onConflict: 'course_slug'/);

const orders = read('api/orders.js');
assert.match(orders, /syncV4EnrollmentToLms/);
assert.match(orders, /delivery_mode \|\| ''\)\.toLowerCase\(\) === 'v4'/);
assert.match(orders, /TEST_DELETE_CONFIRMATION/);
assert.match(orders, /cloudinary\.uploader\.destroy/);
assert.match(orders, /billName\.startsWith\(TEST_TITLE_PREFIX\)/);
assert.match(orders, /String\(course\?\.title \|\| ''\)\.startsWith\(TEST_TITLE_PREFIX\)/);

const oldBillUrl = 'https://res.cloudinary.com/example/image/upload/v1787455642/bill-chuyen-khoan/clone-factory-test-v4-commerce-20260823/i4xtszirwmseoqqrdxek.png';
assert.equal(extractCloudinaryBillPublicId(oldBillUrl, 'clone-factory-test-v4-commerce-20260823'), 'bill-chuyen-khoan/clone-factory-test-v4-commerce-20260823/i4xtszirwmseoqqrdxek');
assert.equal(extractCloudinaryBillPublicId(oldBillUrl, 'real-course'), null);
assert.equal(extractCloudinaryBillPublicId('https://example.com/image/upload/v1/bill.png', 'clone-factory-test-v4-commerce-20260823'), null);

const ordersPage = read('orders.html');
assert.match(ordersPage, /Xóa dữ liệu test/);
assert.match(ordersPage, /confirmation: 'DELETE_CLONE_FACTORY_TEST'/);

const admin = read('admin.html');
assert.match(admin, /id="v4SourceInput"/);
assert.match(admin, /Nguồn V4 đã có/);
assert.match(admin, /\/api\/courses\?action=v4-sources/);
assert.doesNotMatch(admin, /\/api\/v4-sources/);
assert.match(admin, /id="v4TelegramPostLinkInput"/);
assert.match(admin, /continueV4Setup/);
assert.doesNotMatch(admin, /deliveryMode === 'v4' && !v4SourceId/);

console.log('V4 self-service Commerce flow checks passed');
