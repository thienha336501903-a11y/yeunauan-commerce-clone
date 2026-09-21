import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const register = fs.readFileSync(new URL('../api/register.js', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../api/config.js', import.meta.url), 'utf8');

test('direct V5 registration allows pre-order when active while checking canonical readiness if published', () => {
  assert.match(register, /getV5Readiness\(courseRec\.id\)/);
  assert.match(register, /if \(courseRec\.active !== true\)/);
  assert.match(register, /if \(courseRec\.is_published === true\)/);
  assert.match(register, /if \(!readiness\.ready\)/);
  assert.match(register, /release Published hợp lệ/);
});

test('admin readiness route is authenticated and reports sale readiness separately from canonical content readiness', () => {
  assert.match(config, /adminReadiness/);
  assert.match(config, /handleV5AdminReadiness/);
  assert.match(config, /x-admin-password/);
  assert.match(config, /adminPassword !== process\.env\.ADMIN_PASSWORD/);
  assert.match(config, /getV5Readiness\(course\.id\)/);
  assert.match(config, /canonicalReady: readiness\.ready === true/);
  assert.match(config, /canSell: isCourseForSale\(course\)/);
});
