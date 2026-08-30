import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../utils/v5-sync-helpers.js', import.meta.url), 'utf8');

test('V5 course sync preserves sale state when active is omitted', () => {
  assert.match(source, /hasOwn\(courseData, 'active'\)/);
  assert.match(source, /payload\.active = courseData\.active === true/);
  assert.doesNotMatch(source, /active:\s*courseData\.active === true/);
});

test('V5 course sync preserves start date when expected_start_date is omitted', () => {
  assert.match(source, /hasOwn\(courseData, 'expected_start_date'\)/);
  assert.match(source, /payload\.expected_start_date = courseData\.expected_start_date \|\| null/);
  assert.doesNotMatch(source, /expected_start_date:\s*courseData\.expected_start_date \|\| null/);
});
