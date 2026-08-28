import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseDeliveryMode } from '../utils/delivery-policy.js';
import { syncV5CourseToLms, syncV5EnrollmentToLms } from '../utils/v5-sync-helpers.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('delivery policy preserves V5 and exposes strict parsing for admin APIs', () => {
  const policy = read('utils/delivery-policy.js');
  assert.match(policy, /\['lms', 'telegram', 'v4', 'v5'\]/);
  assert.match(policy, /mode === 'v5' \? 'v5'/);
  assert.equal(parseDeliveryMode('v5'), 'v5');
  assert.equal(parseDeliveryMode(''), null);
  assert.equal(parseDeliveryMode('unknown'), null);
});

test('V5 sync helper uses isolated Preview and Production targets and never legacy Portal', () => {
  const helper = read('utils/v5-sync-helpers.js');
  assert.match(helper, /process\.env\.V5_SYNC_SECRET \|\| process\.env\.INTERNAL_SYNC_SECRET/);
  assert.match(helper, /process\.env\.VERCEL_ENV === 'preview' \? process\.env\.V5_LMS_SYNC_URL : ''/);
  assert.match(helper, /process\.env\.V5_LMS_PUBLIC_URL/);
  assert.match(helper, /cloneConfig\(\)\.v4PublicUrl/);
  assert.match(helper, /previewOverride \|\| productionV5Base\(\)/);
  assert.match(helper, /\/api\/v5-sync/);
  assert.match(helper, /X-Sync-Secret/);
  assert.match(helper, /SKIPPED_V5/);
  assert.doesNotMatch(helper, /SYSTEM1_URL/);
  assert.doesNotMatch(helper, /PORTAL_URL/);
  assert.doesNotMatch(helper, /process\.env\.LMS_PUBLIC_URL/);
});

test('V5 course sync preserves existing sale state when active is omitted', async t => {
  const keys = ['VERCEL_ENV', 'V5_SYNC_SECRET', 'INTERNAL_SYNC_SECRET', 'V4_PUBLIC_URL', 'V5_LMS_PUBLIC_URL'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  t.after(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    global.fetch = originalFetch;
  });
  process.env.VERCEL_ENV = 'production';
  process.env.V5_SYNC_SECRET = 'v5-dedicated-secret';
  process.env.V4_PUBLIC_URL = 'https://v4-runtime.example';
  delete process.env.V5_LMS_PUBLIC_URL;
  let payload = null;
  global.fetch = async (_url, options = {}) => {
    payload = JSON.parse(String(options.body || '{}'));
    return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
  };
  const result = await syncV5CourseToLms({ slug: 'v5-course', courseName: 'V5 Course' });
  assert.equal(result.lms, 'SUCCESS');
  assert.equal(Object.hasOwn(payload, 'active'), false);
});

test('Production V5 runtime ignores stale LMS_PUBLIC_URL and prefers dedicated V5 secret', async t => {
  const keys = ['VERCEL_ENV', 'V5_SYNC_SECRET', 'INTERNAL_SYNC_SECRET', 'V4_PUBLIC_URL', 'LMS_PUBLIC_URL', 'V5_LMS_PUBLIC_URL', 'V5_LMS_SYNC_URL'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  t.after(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    global.fetch = originalFetch;
  });

  process.env.VERCEL_ENV = 'production';
  process.env.V5_SYNC_SECRET = 'v5-dedicated-secret';
  process.env.INTERNAL_SYNC_SECRET = 'legacy-secret';
  process.env.V4_PUBLIC_URL = 'https://v4-runtime.example';
  process.env.LMS_PUBLIC_URL = 'https://stale-lms.example';
  delete process.env.V5_LMS_PUBLIC_URL;
  delete process.env.V5_LMS_SYNC_URL;

  let calledUrl = '';
  let sentSecret = '';
  global.fetch = async (url, options = {}) => {
    calledUrl = String(url);
    sentSecret = String(options.headers?.['X-Sync-Secret'] || '');
    return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
  };

  const result = await syncV5EnrollmentToLms({
    id: '00000000-0000-4000-8000-000000000001',
    customer_email: 'student@example.com',
    course_slug: 'v5-course'
  }, 'create');

  assert.equal(result.lms, 'SUCCESS');
  assert.equal(result.portal, 'SKIPPED_V5');
  assert.equal(calledUrl, 'https://v4-runtime.example/api/v5-sync');
  assert.equal(sentSecret, 'v5-dedicated-secret');
  assert.doesNotMatch(calledUrl, /stale-lms/);
});

test('generic sync helper delegates V5 course and enrollment without legacy side effects', () => {
  const sync = read('utils/sync-helpers.js');
  assert.match(sync, /resolvedMode === 'v5'\) return syncV5CourseToLms/);
  assert.match(sync, /resolvedMode === 'v5'\) return syncV5EnrollmentToLms/);
});

test('V5 enrollment sync preserves Commerce order correlation and explicit create/restore/revoke actions', () => {
  const helper = read('utils/v5-sync-helpers.js');
  assert.match(helper, /orderId: String\(orderData\.id \|\| orderData\.source_order_id \|\| ''\)\.trim\(\) \|\| null/);
  assert.match(helper, /const actionMap = \{[\s\S]*create:\s*'syncEnrollment'[\s\S]*restore:\s*'restoreEnrollment'[\s\S]*revoke:\s*'revokeEnrollment'/);
  assert.match(helper, /const action = actionMap\[String\(actionType \|\| ''\)\.trim\(\)\.toLowerCase\(\)\]/);
});

test('V5 storefront/config and registration both fail closed until canonical content is Published', () => {
  const config = read('api/config.js');
  const register = read('api/register.js');
  assert.match(config, /if \(deliveryMode === 'v5'\) \{[\s\S]*course\.is_published !== true[\s\S]*getV5Readiness\(course\.id\)[\s\S]*!readiness\.ready/);
  assert.match(register, /if \(deliveryMode === 'v5'\) \{[\s\S]*courseRec\.active !== true \|\| courseRec\.is_published !== true[\s\S]*getV5Readiness\(courseRec\.id\)[\s\S]*!readiness\.ready/);
  assert.match(register, /SKIPPED_V5/);
  assert.match(register, /\['v4', 'v5'\]\.includes\(deliveryMode\)/);
  assert.match(register, /\/my-courses\.html\?registered=1&course=/);
});

test('bulk approval preserves V5 portal isolation through dedicated sync-first helper', () => {
  const bulk = read('api/approve-all.js');
  assert.match(bulk, /normalized === "v5"\) return "SKIPPED_V5"/);
  assert.match(bulk, /for \(const order of v5Orders\)[\s\S]*approveV5Order\(order\)/);
  assert.match(bulk, /for \(const order of updatedStandardOrders\)[\s\S]*syncEnrollmentToExternalSystems\(order, "create"\)/);
});
