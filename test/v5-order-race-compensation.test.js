import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const approval = fs.readFileSync(new URL('../utils/v5-order-approval.js', import.meta.url), 'utf8');
const sync = fs.readFileSync(new URL('../utils/v5-sync-helpers.js', import.meta.url), 'utf8');

test('V5 sync actions are explicit and approved-order recovery uses restore instead of create', () => {
  assert.match(sync, /restore:\s*'restoreEnrollment'/);
  assert.match(sync, /Invalid V5 enrollment sync action/);
  assert.match(approval, /const action = approved \? 'restore' : 'revoke'/);
  assert.match(approval, /v5ExistingAccessReadiness/);
});

test('approved existing access ignores Commerce sale switch but still requires Published content', () => {
  assert.match(approval, /v5OrderReadiness\(order, \{ requireSale = true \} = \{\}\)/);
  assert.match(approval, /if \(course\.is_published !== true\)/);
  assert.match(approval, /if \(requireSale && course\.active !== true\)/);
  assert.match(approval, /v5OrderReadiness\(order, \{ requireSale: false \}\)/);
});

test('order-write race compensation re-reads current DB state before changing entitlement', () => {
  assert.match(approval, /currentOrderForCompensation/);
  assert.match(approval, /select\('id,status,customer_email,course_id,course_slug,delivery_mode'\)/);
  assert.match(approval, /const shouldHaveAccess = current\.status === 'Đã duyệt'/);
});

test('approval race keeps a grant when another writer already approved and revokes otherwise', () => {
  assert.match(approval, /attemptedAction === 'create'/);
  assert.match(approval, /CURRENT_ORDER_ALREADY_APPROVED/);
  assert.match(approval, /syncV5EnrollmentToLms\(current, 'revoke'\)/);
});

test('revoke race keeps revoke for non-approved state and restores only a still-approved order', () => {
  assert.match(approval, /attemptedAction === 'revoke'/);
  assert.match(approval, /CURRENT_ORDER_NO_LONGER_APPROVED/);
  assert.match(approval, /syncV5EnrollmentToLms\(current, 'restore'\)/);
});
