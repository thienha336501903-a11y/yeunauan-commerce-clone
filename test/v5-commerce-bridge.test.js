import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('delivery policy preserves V5 instead of degrading it to legacy LMS', () => {
  const policy = read('utils/delivery-policy.js');
  assert.match(policy, /\['lms', 'telegram', 'v4', 'v5'\]/);
  assert.match(policy, /mode === 'v5' \? 'v5'/);
});

test('V5 sync helper uses the isolated LMS endpoint and never legacy Portal', () => {
  const helper = read('utils/v5-sync-helpers.js');
  assert.match(helper, /process\.env\.VERCEL_ENV === 'preview' \? process\.env\.V5_LMS_SYNC_URL : ''/);
  assert.match(helper, /previewOverride \|\| process\.env\.LMS_PUBLIC_URL \|\| process\.env\.SYSTEM3_URL/);
  assert.match(helper, /\/api\/v5-sync/);
  assert.match(helper, /X-Sync-Secret/);
  assert.match(helper, /SKIPPED_V5/);
  assert.doesNotMatch(helper, /SYSTEM1_URL/);
  assert.doesNotMatch(helper, /PORTAL_URL/);
});

test('generic sync helper delegates V5 course and enrollment without legacy side effects', () => {
  const sync = read('utils/sync-helpers.js');
  assert.match(sync, /resolvedMode === 'v5'\) return syncV5CourseToLms/);
  assert.match(sync, /resolvedMode === 'v5'\) return syncV5EnrollmentToLms/);
});

test('V5 enrollment sync preserves Commerce order correlation for FK-backed entitlement', () => {
  const helper = read('utils/v5-sync-helpers.js');
  assert.match(helper, /orderId: String\(orderData\.id \|\| orderData\.source_order_id \|\| ''\)\.trim\(\) \|\| null/);
  assert.match(helper, /action: actionType === 'create' \? 'syncEnrollment' : 'revokeEnrollment'/);
});

test('V5 registration requires published content and returns System B course manager', () => {
  const register = read('api/register.js');
  assert.match(register, /deliveryMode === 'v5' && courseRec\.is_published !== true/);
  assert.match(register, /SKIPPED_V5/);
  assert.match(register, /\['v4', 'v5'\]\.includes\(deliveryMode\)/);
  assert.match(register, /\/my-courses\.html\?registered=1&course=/);
});

test('bulk approval preserves V5 portal isolation while using generic V5-aware sync', () => {
  const bulk = read('api/approve-all.js');
  assert.match(bulk, /normalized === "v5"\) return "SKIPPED_V5"/);
  assert.match(bulk, /syncEnrollmentToExternalSystems\(order, "create"\)/);
});
