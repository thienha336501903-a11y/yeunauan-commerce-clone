import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const patch = fs.readFileSync(new URL('../docs/patches/commerce-v5-admin-ui.patch', import.meta.url), 'utf8');

test('staged Commerce admin patch explicitly represents LMS V5', () => {
  assert.match(patch, /<option value="v5">Học trên LMS V5<\/option>/);
  assert.match(patch, /LMS V5/);
  assert.match(patch, /v5CourseFields/);
});

test('existing V5 mode is locked and content lifecycle opens canonical V5 Channel', () => {
  assert.match(patch, /deliveryModeInput\.disabled = editingV5/);
  assert.match(patch, /openV5Channel/);
  assert.match(patch, /v5-admin\.html\?course=/);
  assert.match(patch, /Trạng thái nội dung canonical V5/);
});

test('V5 UI reads canonical readiness before sale activation', () => {
  assert.match(patch, /\/api\/v5-readiness\?course=/);
  assert.match(patch, /readiness\.canonicalReady/);
  assert.match(patch, /chưa có Published release hợp lệ/);
});

test('generic V5 publish/original lesson controls do not own V5 lifecycle', () => {
  assert.match(patch, /if \(course\.deliveryMode === 'v5'\)[\s\S]*openV5Channel\(course\.slug\)/);
  assert.match(patch, /Nội dung LMS V5 được quản lý tại V5 Channel/);
  assert.match(patch, /deliveryMode: course\.deliveryMode \|\| 'lms'/);
});
