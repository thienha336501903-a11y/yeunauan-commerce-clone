import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const register = fs.readFileSync(new URL('../api/register.js', import.meta.url), 'utf8');
const checkout = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('registration returns an absolute Main LMS course-manager URL for non-Telegram modes', () => {
  assert.ok(register.includes("const managerPath = runtime.lmsPublicUrl.replace(/\\/$/, '')"));
  assert.ok(register.includes("'/my-courses.html?registered=1&course=' + encodeURIComponent(courseSlug)"));
  assert.doesNotMatch(register, /legacyPortalPublicUrl|SYSTEM1_URL/);
});

test('checkout generic handoff honors managerPath and falls back only to Main LMS', () => {
  assert.match(checkout, /window\.location\.href=data\.managerPath\|\|window\.CLONE_RUNTIME_CONFIG\?\.lmsPublicUrl\|\|location\.origin/);
  assert.doesNotMatch(checkout, /legacyPortalPublicUrl/);
});
