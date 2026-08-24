import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('Commerce exposes a per-course original lesson entry toggle', () => {
  const admin = read('admin.html');
  assert.match(admin, /course\.originalLessonEntryVisible !== false/);
  assert.match(admin, /Ẩn bài học gốc/);
  assert.match(admin, /Hiện bài học gốc/);
  assert.match(admin, /toggleOriginalLessonEntry/);
  assert.match(admin, /originalLessonEntryVisible: nextVisible/);
  assert.match(admin, /Học viên vẫn xem được Công thức &amp; Hướng dẫn nhưng chưa thể mở LMS/);
});

test('courses API stores only an explicit boolean in merged raw_data', () => {
  const courses = read('api/courses.js');
  assert.match(courses, /hasOwn\(body, 'originalLessonEntryVisible'\)/);
  assert.match(courses, /typeof body\.originalLessonEntryVisible !== 'boolean'/);
  assert.match(courses, /rawDataPatch\.originalLessonEntryVisible = body\.originalLessonEntryVisible/);
  assert.match(courses, /base\.raw_data = \{ \.\.\.\(existing\.raw_data \|\| \{\}\), \.\.\.base\.raw_data \}/);
});
