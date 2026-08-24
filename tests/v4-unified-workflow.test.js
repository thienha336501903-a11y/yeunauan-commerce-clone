import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('Commerce keeps unified V4 orchestration inside the existing courses function', () => {
  const courses = read('api/courses.js');
  assert.match(courses, /handleV4Workflow/);
  assert.match(courses, /requestAction === 'v4-workflow'/);
});

test('new Telegram source registration is server-to-server and fail-closed', () => {
  const workflow = read('utils/v4-workflow.js');
  assert.match(workflow, /process\.env\.INTERNAL_SYNC_SECRET/);
  assert.match(workflow, /X-Sync-Secret/);
  assert.match(workflow, /api\/admin\?action=v4-source/);
  assert.match(workflow, /if \(!secret\)/);
  assert.match(workflow, /delivery_mode/);
  assert.match(workflow, /is_published/);
  assert.match(workflow, /onConflict: 'course_slug'/);
});

test('full preflight and publish reuse the LMS internal bridge', () => {
  const workflow = read('utils/v4-workflow.js');
  assert.match(workflow, /lmsAction\('v4PrepareRelease'/);
  assert.match(workflow, /testEmail/);
  assert.match(workflow, /lmsAction\('setV4Published'/);
  assert.match(workflow, /published:\s*true/);
});

test('workflow status reads Reader state without mutating real data', () => {
  const workflow = read('utils/v4-workflow.js');
  assert.match(workflow, /tgcloner_reader_jobs/);
  assert.match(workflow, /actualMessageCount/);
  assert.match(workflow, /readyForPreflight/);
  assert.doesNotMatch(workflow, /delete\(\).*tgcloner_reader_jobs/);
});

test('Commerce admin keeps the complete V4 setup in one modal', () => {
  const admin = read('admin.html');
  assert.match(admin, /Lưu nháp & nhập nội dung/);
  assert.match(admin, /v4WorkflowStatus/);
  assert.match(admin, /runUnifiedV4Preflight/);
  assert.match(admin, /publishUnifiedV4/);
  assert.match(admin, /registerUnifiedV4Source/);
  assert.doesNotMatch(admin, /v4-course-wizard\.html/);
  assert.doesNotMatch(admin, /location\.href\s*=\s*v4WizardUrl/);
});

test('Commerce admin explains the V4 workflow as four numbered steps', () => {
  const admin = read('admin.html');
  assert.match(admin, /id="v4StepGuide"/);
  assert.match(admin, /Quy trình tạo khóa V4/);
  assert.match(admin, /Thông tin khóa học/);
  assert.match(admin, /Nhập nội dung Telegram/);
  assert.match(admin, /Bước 3 · Kiểm tra và Publish/);
  assert.match(admin, /Bật bán khóa học/);
  assert.match(admin, /scrollToV4Step/);
  assert.match(admin, /updateV4StepGuide/);
  assert.match(admin, /Lưu thông tin & sang bước 2/);
  assert.match(admin, /Bật bán & lưu/);
  assert.match(admin, /Nguồn Telegram/);
  assert.match(admin, /Nội dung Reader/);
  assert.match(admin, /Trạng thái Publish/);
  assert.doesNotMatch(admin, /<b>1\. Nguồn<\/b>/);
});

test('Reader pairing remains one-field setup and carries the selected V4 server', () => {
  const admin = read('admin.html');
  assert.match(admin, /pairing\.connection_code \|\| pairing\.code/);
  assert.match(admin, /Mã kết nối một lần/);
  assert.match(admin, /Ứng dụng tự chọn đúng máy chủ V4/);
});
