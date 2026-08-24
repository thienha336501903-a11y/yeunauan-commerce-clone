import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('Commerce proxies Reader Manager only through the authenticated V4 workflow', () => {
  const workflow = read('utils/v4-workflow.js');
  const courses = read('api/courses.js');
  assert.match(courses, /handleV4Workflow/);
  assert.match(workflow, /X-Sync-Secret/);
  assert.match(workflow, /action=reader-manager/);
  assert.match(workflow, /action === 'readerState'/);
  assert.match(workflow, /action === 'createReaderPairing'/);
  assert.match(workflow, /action === 'readerAdmin'/);
  assert.match(workflow, /\['pause_profile', 'resume_profile', 'revoke_profile', 'revoke_agent'\]/);
  assert.doesNotMatch(read('admin.html'), /TELEGRAM_API_HASH|READER_INGEST_SECRET/);
});

test('V4 source registration supports automatic or explicit Reader assignment', () => {
  const workflow = read('utils/v4-workflow.js');
  const admin = read('admin.html');
  assert.match(workflow, /reader_profile_id/);
  assert.match(admin, /id="v4ReaderProfileInput"/);
  assert.match(admin, /Tự động chọn Reader phù hợp/);
  assert.match(admin, /registerSource.*readerProfileId/s);
});

test('basic admin can pair, inspect, pause and revoke Reader profiles without commands', () => {
  const admin = read('admin.html');
  assert.match(admin, /Tạo mã ghép máy/);
  assert.match(admin, /Mã chỉ dùng một lần và hết hạn sau 10 phút/);
  assert.match(admin, /Tải ứng dụng Windows/);
  assert.match(admin, /readerAdminAction/);
  assert.doesNotMatch(admin, /python(?:3)?\s|pip install|git clone/i);
});

test('Reader selection precedes Telegram import and exposes live operational detail', () => {
  const admin = read('admin.html');
  const readerPosition = admin.indexOf('id="v4ReaderProfileInput"');
  const linkPosition = admin.indexOf('id="v4TelegramPostLinkInput"');
  assert.ok(readerPosition > -1 && linkPosition > readerPosition);
  assert.match(admin, /readerStatusDot/);
  assert.match(admin, /usage_today/);
  assert.match(admin, /recent_sources/);
  assert.match(admin, /Lần dùng hôm nay/);
  assert.match(admin, /Kênh gần đây/);
  assert.match(admin, /id="readerPairingSetup"/);
  assert.match(admin, /Ghép thêm máy Reader/);
});

test('Telegram import shows staged auto-refresh progress without a manual refresh button', () => {
  const admin = read('admin.html');
  assert.match(admin, /id="v4ImportProgressBar"/);
  assert.match(admin, /progress_stage/);
  assert.match(admin, /progress_current/);
  assert.match(admin, /progress_total/);
  assert.match(admin, /scheduleV4StatusPolling/);
  assert.doesNotMatch(admin, />Kiểm tra lại<\/button>/);
});

test('Step 3 grants test Gmail, combines refresh with preflight and returns V4 link', () => {
  const workflow = read('utils/v4-workflow.js');
  const admin = read('admin.html');
  assert.match(admin, /id="v4TestEmailInput"/);
  assert.match(admin, /await refreshV4WorkflowStatus\(\)/);
  assert.match(admin, /workflowAction, \.\.\.payload/);
  assert.match(admin, /testEmail/);
  assert.match(admin, /id="v4StudentLinkResult"/);
  assert.match(admin, /data\.studentUrl/);
  assert.match(workflow, /v4PrepareRelease/);
  assert.match(workflow, /testEmail: req\.body\?\.testEmail/);
});
