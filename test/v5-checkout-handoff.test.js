import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const register = fs.readFileSync(new URL('../api/register.js', import.meta.url), 'utf8');
const checkout = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('V5 registration returns an absolute LMS course-manager URL', () => {
  assert.match(register, /deliveryMode === 'v5'[\s\S]*runtime\.lmsPublicUrl\.replace\(\/\\\/$\/, ''\)[\s\S]*\/my-courses\.html\?registered=1&course=/);
  assert.match(register, /deliveryMode === 'v4'[\s\S]*'\/my-courses\.html\?registered=1&course='/);
});

test('checkout generic handoff honors an absolute managerPath', () => {
  assert.match(checkout, /window\.location\.href=data\.managerPath\|\|window\.CLONE_RUNTIME_CONFIG\?\.legacyPortalPublicUrl\|\|location\.origin/);
});
