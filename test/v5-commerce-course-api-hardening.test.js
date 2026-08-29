import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../api/courses.js', import.meta.url), 'utf8');

test('admin writes use strict delivery-mode validation instead of silently coercing to LMS', () => {
  assert.match(source, /requireDeliveryMode/);
  assert.match(source, /requestedDeliveryMode\(body\)/);
  assert.match(source, /hasOwn\(body, 'deliveryMode'\) \|\| hasOwn\(body, 'delivery_mode'\)/);
});

test('new V5 shells are forced off-sale and unpublished', () => {
  assert.match(source, /if \(deliveryMode === 'v5'\) \{\s*base\.active = false;\s*base\.is_published = false;/);
});

test('existing V5 mode cannot be downgraded or generic-converted', () => {
  assert.match(source, /existingMode === 'v5' && deliveryMode !== 'v5'/);
  assert.match(source, /Khóa V5 không thể đổi hình thức học bằng chỉnh sửa Commerce/);
  assert.match(source, /existingMode !== 'v5' && deliveryMode === 'v5'/);
  assert.match(source, /Không chuyển khóa hiện hữu sang V5 bằng chỉnh sửa Commerce/);
});

test('V5 readiness gates both ready/sale flags against canonical release state', () => {
  assert.match(source, /getV5Readiness\(existing\.id\)/);
  assert.match(source, /effectivePublished \|\| effectiveActive/);
  assert.match(source, /canonical Published release hợp lệ/);
});

test('V5 metadata sync uses explicit delivery mode without replaying shared sale state', () => {
  assert.match(source, /slug: data\.slug/);
  assert.match(source, /active: data\.active/);
  assert.match(source, /deliveryMode: mode\(data\.delivery_mode\)/);
  assert.match(source, /if \(deliveryMode === 'v5'\) delete externalCourse\.active/);
  assert.match(source, /syncCourseToExternalSystems\(externalCourse\)/);
});

test('generic Commerce delete refuses canonical V5 data', () => {
  assert.match(source, /from\('v5_course_configs'\)/);
  assert.match(source, /Không xóa khóa V5 canonical từ Commerce/);
});
