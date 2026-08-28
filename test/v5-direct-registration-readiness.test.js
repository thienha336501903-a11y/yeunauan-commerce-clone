import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const register = fs.readFileSync(new URL('../api/register.js', import.meta.url), 'utf8');
const readiness = fs.readFileSync(new URL('../api/v5-readiness.js', import.meta.url), 'utf8');

test('direct V5 registration independently requires canonical Published readiness', () => {
  assert.match(register, /getV5Readiness\(courseRec\.id\)/);
  assert.match(register, /courseRec\.active !== true \|\| courseRec\.is_published !== true/);
  assert.match(register, /if \(!readiness\.ready\)/);
  assert.match(register, /release Published hợp lệ/);
});

test('admin readiness endpoint is authenticated and reports sale readiness separately from canonical content readiness', () => {
  assert.match(readiness, /x-admin-password/);
  assert.match(readiness, /adminPassword !== process\.env\.ADMIN_PASSWORD/);
  assert.match(readiness, /getV5Readiness\(course\.id\)/);
  assert.match(readiness, /canonicalReady: readiness\.ready === true/);
  assert.match(readiness, /canSell: readiness\.ready === true && course\.active === true && course\.is_published === true/);
});
