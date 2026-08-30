import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../utils/v5-order-approval.js', import.meta.url), 'utf8');

test('V5 order commit CAS covers entitlement identity as well as status', () => {
  assert.match(source, /function guardOrderIdentity/);
  assert.match(source, /\.eq\('status', order\.status\)/);
  assert.match(source, /\.eq\('customer_email', identity\.email\)/);
  assert.match(source, /\.eq\('course_id', identity\.courseId\)/);
  assert.match(source, /\.eq\('course_slug', identity\.courseSlug\)/);
  assert.match(source, /\.eq\('delivery_mode', identity\.deliveryMode\)/);
  assert.match(source, /guardOrderIdentity\(supabase\.from\('orders'\)\.update/);
});

test('create-race compensation revokes the identity that was actually granted', () => {
  assert.match(source, /if \(!shouldHaveAccess\) return syncV5EnrollmentToLms\(order, 'revoke'\)/);
  assert.doesNotMatch(source, /if \(!shouldHaveAccess\) return syncV5EnrollmentToLms\(current, 'revoke'\)/);
});

test('approved identity drift revokes stale grant then restores current DB identity', () => {
  assert.match(source, /sameEntitlementIdentity\(current, order\)/);
  assert.match(source, /const revokeStale = await syncV5EnrollmentToLms\(order, 'revoke'\)/);
  assert.match(source, /const restoreCurrent = await syncV5EnrollmentToLms\(current, 'restore'\)/);
  assert.match(source, /REVOKED_STALE_IDENTITY_AND_RESTORED_CURRENT/);
});

test('revoke-race recovery restores the current approved DB identity', () => {
  assert.match(source, /attemptedAction === 'revoke'/);
  assert.match(source, /return syncV5EnrollmentToLms\(current, 'restore'\)/);
});
