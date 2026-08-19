import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const checkout = read('index.html');
assert.match(checkout, /redirecting to V4 course manager/);
assert.match(checkout, /my-courses\.html\?registered=1&course=/);
assert.doesNotMatch(checkout, /redirecting to V4 Web entry/);

const register = read('api/register.js');
assert.match(register, /sync_portal_status = 'SKIPPED_V4'/);
assert.match(register, /deliveryMode === 'lms'/);
assert.match(register, /my-courses\.html\?registered=1&course=/);

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

const admin = read('admin.html');
assert.match(admin, /id="v4SourceInput"/);
assert.match(admin, /Nguồn nội dung V4/);
assert.match(admin, /\/api\/courses\?action=v4-sources/);
assert.doesNotMatch(admin, /\/api\/v4-sources/);
assert.match(admin, /deliveryMode === 'v4' && !v4SourceId/);

console.log('V4 self-service Commerce flow checks passed');
