import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('all Commerce responses receive the structural security baseline', () => {
  const rule = config.headers.find(item => item.source === '/(.*)');
  assert.ok(rule);
  const headers = Object.fromEntries(rule.headers.map(item => [item.key, item.value]));
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.match(headers['Strict-Transport-Security'], /max-age=31536000/);
  assert.match(headers['Content-Security-Policy'], /object-src 'none'/);
  assert.match(headers['Content-Security-Policy'], /form-action 'self'/);
  assert.match(headers['Content-Security-Policy'], /upgrade-insecure-requests/);
});
