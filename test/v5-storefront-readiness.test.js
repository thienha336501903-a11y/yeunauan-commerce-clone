import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const readiness = fs.readFileSync(new URL('../utils/v5-readiness.js', import.meta.url), 'utf8');
const configSource = fs.readFileSync(new URL('../api/config.js', import.meta.url), 'utf8');

test('canonical V5 readiness requires a published config pointing to the matching published release', () => {
  assert.match(readiness, /config\.status \|\| ''\)\.toLowerCase\(\) !== 'published'/);
  assert.match(readiness, /published_release_id/);
  assert.match(readiness, /String\(release\.id \|\| ''\) !== releaseId/);
  assert.match(readiness, /String\(release\.course_id \|\| ''\) !== id/);
  assert.match(readiness, /release\.status \|\| ''\)\.toLowerCase\(\) !== 'published'/);
  assert.match(readiness, /return \{ ready: true, reason: null, releaseId \}/);
});

test('readiness DB lookup scopes the release to the same course', () => {
  assert.match(readiness, /\.from\('v5_releases'\)[\s\S]*\.eq\('id', releaseId\)[\s\S]*\.eq\('course_id', id\)/);
});

test('storefront config checks canonical V5 readiness before exposing checkout', () => {
  assert.match(configSource, /getV5Readiness\(course\.id\)/);
  assert.match(configSource, /if \(!readiness\.ready\)/);
  assert.match(configSource, /V5 storefront blocked by canonical readiness/);
  assert.match(configSource, /Khóa học V5 chưa sẵn sàng/);
});
