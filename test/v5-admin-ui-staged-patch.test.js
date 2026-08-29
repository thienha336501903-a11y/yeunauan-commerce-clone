import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const admin = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');

test('Commerce admin explicitly represents LMS V5', () => {
  assert.match(admin, /<option value="v5">Học trên LMS V5<\/option>/);
  assert.match(admin, /id="v5CourseFields"/);
  assert.match(admin, /LMS V5/);
});

test('existing V5 mode is locked and content lifecycle opens canonical V5 Channel', () => {
  assert.match(admin, /deliveryModeInput\.disabled = editingV5/);
  assert.match(admin, /editingV5 = course\.deliveryMode === 'v5'/);
  assert.match(admin, /v5-admin\.html\?course=/);
  assert.match(admin, /Trạng thái nội dung canonical V5/);
});

test('V5 UI reads canonical readiness before sale activation', () => {
  assert.match(admin, /\/api\/config\?adminReadiness=1&course=/);
  assert.match(admin, /readiness\.canonicalReady/);
  assert.match(admin, /Published release hợp lệ/);
  assert.match(admin, /if \(!currentStatus && course\.deliveryMode === 'v5'\)/);
});

test('sale toggle never writes the canonical publish flag', () => {
  const saleToggle = admin.slice(
    admin.indexOf('async function toggleCourseActive'),
    admin.indexOf('async function toggleCoursePublished')
  );
  assert.match(saleToggle, /active:\s*!currentStatus/);
  assert.doesNotMatch(saleToggle, /^\s*is_published\s*:/m);
});

test('Commerce API ignores canonical publish writes for existing V5 courses', () => {
  const coursesApi = fs.readFileSync(new URL('../api/courses.js', import.meta.url), 'utf8');
  assert.match(coursesApi, /if \(deliveryMode === 'v5'\) delete base\.is_published/);
});

test('generic V5 content controls do not own V5 lifecycle', () => {
  assert.match(admin, /Nội dung LMS V5 được quản lý tại V5 Channel/);
  assert.match(admin, /openV5Channel\(course\.slug\)/);
  assert.match(admin, /course\.deliveryMode === 'v5' \? 'hidden'/);
});

test('temporary admin rollout machinery is removed from the branch', () => {
  assert.equal(fs.existsSync(new URL('../docs/patches/commerce-v5-admin-ui.patch', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('../.github/workflows/apply-v5-admin-ui.yml', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('../.github/workflows/apply-v5-admin-ui-v2.yml', import.meta.url)), false);
});
