import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const register = fs.readFileSync(new URL('../api/register.js', import.meta.url), 'utf8');
const checkout = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('V5 registration returns an absolute LMS course-manager URL', () => {
  assert.ok(register.includes("const managerPath = ['v4', 'v5'].includes(deliveryMode)"));
  assert.ok(register.includes("deliveryMode === 'v5' ? runtime.lmsPublicUrl.replace(/\\/$/, '') : ''"));
  assert.ok(register.includes("'/my-courses.html?registered=1&course=' + encodeURIComponent(courseSlug)"));
});

test('checkout generic handoff honors an absolute managerPath', () => {
  assert.match(checkout, /window\.location\.href=data\.managerPath\|\|window\.CLONE_RUNTIME_CONFIG\?\.legacyPortalPublicUrl\|\|location\.origin/);
});
