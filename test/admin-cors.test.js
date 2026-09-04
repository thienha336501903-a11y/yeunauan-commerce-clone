import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { enforceSameOriginAdminRequest } from '../utils/admin-cors.js';

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    ended: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; }
  };
}

test('same-origin Commerce admin requests are allowed without wildcard CORS', () => {
  const req = { method: 'GET', headers: { origin: 'https://yeubep.shop', host: 'yeubep.shop', 'x-forwarded-proto': 'https' } };
  const res = response();
  assert.equal(enforceSameOriginAdminRequest(req, res, ['GET', 'OPTIONS']), true);
  assert.equal(res.headers['access-control-allow-origin'], 'https://yeubep.shop');
  assert.notEqual(res.headers['access-control-allow-origin'], '*');
});

test('foreign-origin Commerce admin requests fail before password authorization', () => {
  const req = { method: 'GET', headers: { origin: 'https://evil.example', host: 'yeubep.shop', 'x-forwarded-proto': 'https' } };
  const res = response();
  assert.equal(enforceSameOriginAdminRequest(req, res, ['GET', 'OPTIONS']), false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('same-origin preflight is explicit and foreign or origin-less preflight fails closed', () => {
  const allowed = response();
  assert.equal(enforceSameOriginAdminRequest({ method: 'OPTIONS', headers: { origin: 'https://yeubep.shop', host: 'yeubep.shop' } }, allowed, ['POST', 'OPTIONS']), false);
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.ended, true);

  for (const headers of [{ origin: 'null', host: 'yeubep.shop' }, { host: 'yeubep.shop' }]) {
    const denied = response();
    assert.equal(enforceSameOriginAdminRequest({ method: 'OPTIONS', headers }, denied, ['POST', 'OPTIONS']), false);
    assert.equal(denied.statusCode, 403);
  }
});

test('every password-protected Commerce admin surface uses the shared CORS guard', () => {
  for (const file of ['api/orders.js', 'api/courses.js', 'api/upload.js']) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /enforceSameOriginAdminRequest/);
    assert.doesNotMatch(source, /Access-Control-Allow-Origin['"],\s*['"]\*['"]/);
  }
});
