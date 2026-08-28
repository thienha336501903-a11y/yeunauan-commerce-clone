import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../utils/v5-order-approval.js', import.meta.url), 'utf8');

test('resync success is reconciled to current DB order truth before returning', () => {
  assert.match(source, /const current = await currentOrderForCompensation\(order\.id\)/);
  assert.match(source, /if \(!sameOrderSnapshot\(current, order\)\)/);
  assert.match(source, /compensateOrderWriteRace\(order, action\)/);
  assert.match(source, /v5_order_changed_during_resync/);
});

test('restore is treated as a grant for identity-race compensation', () => {
  assert.match(source, /const granted = attemptedAction === 'create' \|\| attemptedAction === 'restore'/);
  assert.match(source, /REVOKED_STALE_IDENTITY_AND_RESTORED_CURRENT/);
});

test('sync status persistence is guarded by the same order identity and status snapshot', () => {
  assert.match(source, /async function persistSyncState\(order, syncResults\)/);
  assert.match(source, /guardOrderIdentity\(supabase\.from\('orders'\)\.update/);
  assert.match(source, /sameOrderSnapshot/);
});
