import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { evaluateV5Readiness } from '../utils/v5-readiness.js';

const configSource = fs.readFileSync(new URL('../api/config.js', import.meta.url), 'utf8');

test('canonical V5 readiness requires a published config pointing to the matching published release', () => {
  const courseId = '00000000-0000-4000-8000-000000000001';
  const releaseId = '00000000-0000-4000-8000-000000000002';
  assert.deepEqual(
    evaluateV5Readiness(
      { status: 'published', published_release_id: releaseId },
      { id: releaseId, course_id: courseId, status: 'published' },
      courseId
    ),
    { ready: true, reason: null, releaseId }
  );
  assert.equal(evaluateV5Readiness({ status: 'draft', published_release_id: releaseId }, { id: releaseId, course_id: courseId, status: 'published' }, courseId).ready, false);
  assert.equal(evaluateV5Readiness({ status: 'published', published_release_id: releaseId }, { id: releaseId, course_id: courseId, status: 'superseded' }, courseId).ready, false);
  assert.equal(evaluateV5Readiness({ status: 'published', published_release_id: releaseId }, { id: releaseId, course_id: 'other', status: 'published' }, courseId).ready, false);
});

test('storefront config checks canonical V5 readiness before exposing checkout', () => {
  assert.match(configSource, /getV5Readiness\(course\.id\)/);
  assert.match(configSource, /if \(!readiness\.ready\)/);
  assert.match(configSource, /V5 storefront blocked by canonical readiness/);
  assert.match(configSource, /Khóa học V5 chưa sẵn sàng/);
});
