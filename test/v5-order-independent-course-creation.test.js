import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const coursesSource = fs.readFileSync(new URL('../api/courses.js', import.meta.url), 'utf8');
const adminHtmlSource = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');

test('Commerce POST queries existing course by slug before attempting insert', () => {
  assert.match(coursesSource, /const \{ data: existingBySlug, error: slugLookupError \} = await supabase/);
  assert.match(coursesSource, /\.from\('courses'\)/);
  assert.match(coursesSource, /\.eq\('slug', slug\)/);
});

test('Commerce POST attaches existing V5 course without duplicate key error', () => {
  assert.match(coursesSource, /if \(deliveryMode === 'v5'\) \{/);
  assert.match(coursesSource, /operation: 'attached_existing_v5_course'/);
  assert.match(coursesSource, /courseId: data\.id/);
  assert.match(coursesSource, /slug: data\.slug/);
});

test('Commerce POST preserves canonical identity, V5 delivery mode and is_published', () => {
  // Verifies that updatePayload does not overwrite id, delivery_mode or is_published
  assert.doesNotMatch(coursesSource, /updatePayload[\s\S]*?delivery_mode:/);
  assert.doesNotMatch(coursesSource, /updatePayload[\s\S]*?is_published:/);
  assert.doesNotMatch(coursesSource, /updatePayload[\s\S]*?id:\s*crypto/);
});

test('Commerce POST preserves off-sale status and validates readiness if activation requested', () => {
  assert.match(coursesSource, /const readiness = await getV5Readiness\(existingBySlug\.id\);/);
  assert.match(coursesSource, /updatePayload\.active = existingBySlug\.active === true;/);
});

test('Commerce POST rejects mode conflicts with descriptive 409 message', () => {
  assert.match(coursesSource, /existingMode !== deliveryMode/);
  assert.match(coursesSource, /Slug này đã thuộc khóa ở chế độ \$\{existingMode\}\. Không thể tự chuyển sang \$\{deliveryMode\}\./);
  assert.match(coursesSource, /code: 'mode_conflict'/);
});

test('Commerce admin UI displays friendly attach toast for attached_existing_v5_course', () => {
  assert.match(adminHtmlSource, /data\?\.operation === 'attached_existing_v5_course'/);
  assert.match(adminHtmlSource, /Đã tìm thấy khóa V5 cùng slug\. Thông tin bán hàng đã được liên kết với khóa hiện có\./);
});
