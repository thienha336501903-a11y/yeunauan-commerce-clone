import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicCheckoutDisabled } from '../utils/sale-state.js';
import registerHandler from '../api/register.js';

const noTenantDb = { rpc: async () => ({ data: null }), from() { throw new Error('legacy DB must not be read'); } };

function response() {
  return {
    headers: {}, statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; }
  };
}

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('PUBLIC_CHECKOUT_DISABLED: only 1/true close the checkout; unset keeps today\'s behaviour', () => {
  for (const v of ['1', 'true', 'TRUE', ' 1 ']) assert.equal(isPublicCheckoutDisabled({ PUBLIC_CHECKOUT_DISABLED: v }), true, v);
  for (const v of [undefined, '', '0', 'false', 'yes']) assert.equal(isPublicCheckoutDisabled({ PUBLIC_CHECKOUT_DISABLED: v }), false, String(v));
});

test('closed checkout: register answers 409 sale_paused before reading the bill or the DB', async () => {
  await withEnv({ PUBLIC_CHECKOUT_DISABLED: '1', LEGACY_HOST_ALLOWLIST: 'yeubep.shop' }, async () => {
    const req = { method: 'POST', headers: { host: 'yeubep.shop' }, body: { gmail: 'a@gmail.com', billName: 'b.jpg', billType: 'image/jpeg', billData: 'AAAA', course: 'x' }, __options: { supabaseClient: noTenantDb } };
    const res = response();
    await registerHandler(req, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'sale_paused');
  });
});

test('open checkout (flag unset): register goes on to validate the bill as before', async () => {
  await withEnv({ PUBLIC_CHECKOUT_DISABLED: '', LEGACY_HOST_ALLOWLIST: 'yeubep.shop' }, async () => {
    const req = { method: 'POST', headers: { host: 'yeubep.shop' }, body: {}, __options: { supabaseClient: noTenantDb } };
    const res = response();
    await registerHandler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Thiếu dữ liệu');
  });
});

test('public course config and hero honour the flag; admin readiness does not', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.match(read('api/config.js'), /if \(isSalePaused\(course\) \|\| isPublicCheckoutDisabled\(\)\)/);
  assert.match(read('api/hero.js'), /isSalePaused\(course\) \|\| isPublicCheckoutDisabled\(\)/);
  assert.match(read('api/config.js'), /canSell: isCourseForSale\(course\)/);
});
