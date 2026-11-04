import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLmsBinding } from '../utils/lms-fetch.js';
import { secretCheck } from '../utils/secret-check.js';

const KEYS = ['V5_SYNC_SECRET', 'INTERNAL_SYNC_SECRET', 'V5_LMS_PUBLIC_URL', 'LMS_PUBLIC_URL', 'TELEGRAM_CLONER_URL'];

async function withEnv(env, fn) {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    setLmsBinding(null);
  }
}

// Fake lms (via the binding) and Reader that accept only their own secrets; nothing is written.
function fakes({ lmsV5 = 'v5', lmsInternal = 'in', readerInternal = 'in' }) {
  const seen = [];
  setLmsBinding({ fetch: async (url, init) => {
    seen.push(`LMS ${init.method} ${url} ${init.body}`);
    const want = url.endsWith('/api/v5-sync') ? lmsV5 : lmsInternal;
    return new Response('{}', { status: init.headers['X-Sync-Secret'] === want ? 400 : 401 });
  } });
  const reader = async (url, init) => {
    seen.push(`READER ${init.method} ${url}`);
    return new Response('{}', { status: init.headers['X-Sync-Secret'] === readerInternal ? 200 : 401 });
  };
  return { seen, reader };
}

const env = { V5_SYNC_SECRET: 'v5', INTERNAL_SYNC_SECRET: 'in', V5_LMS_PUBLIC_URL: 'https://hoc.example.test', LMS_PUBLIC_URL: 'https://hoc.example.test', TELEGRAM_CLONER_URL: 'https://reader.example.test' };

test('secretCheck: all match through the LMS binding and the Reader; only {} bodies and a GET are sent', () => withEnv(env, async () => {
  const f = fakes({});
  const r = await secretCheck(f.reader);
  assert.equal(r.allMatch, true);
  assert.deepEqual(Object.values(r.checks).map(c => c.status), [400, 400, 200]);
  assert.deepEqual(f.seen, [
    'LMS POST https://hoc.example.test/api/v5-sync {}',
    'LMS POST https://hoc.example.test/api/sync {}',
    'READER GET https://reader.example.test/api/admin?action=reader-manager'
  ]);
  assert.ok(!JSON.stringify(r).includes('"v5"') && !JSON.stringify(r).includes('"in"'), 'secret value in the result');
}));

test('secretCheck: a Reader still on the old INTERNAL_SYNC_SECRET shows mismatch (gate K-ISS pending)', () => withEnv(env, async () => {
  const f = fakes({ readerInternal: 'old' });
  const r = await secretCheck(f.reader);
  assert.equal(r.allMatch, false);
  assert.equal(r.checks.internalReader.verdict, 'mismatch');
  assert.equal(r.checks.v5Sync.verdict, 'match');
}));

test('secretCheck is reachable only through the Admin-authenticated v4-workflow action', () => {
  const workflow = readFileSync(new URL('../utils/v4-workflow.js', import.meta.url), 'utf8');
  const courses = readFileSync(new URL('../api/courses.js', import.meta.url), 'utf8');
  assert.match(workflow, /action === 'secretCheck'/);
  assert.ok(courses.indexOf("x-admin-password") < courses.indexOf("handleV4Workflow(req, res)"));
});
