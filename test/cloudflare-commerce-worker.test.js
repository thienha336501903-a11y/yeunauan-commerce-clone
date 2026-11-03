import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import worker from "../cloudflare/commerce-worker/src/index.js";
import { API_HANDLERS, MAX_BODY_BYTES, route } from "../cloudflare/commerce-worker/src/app.js";

const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const SECURITY = vercel.headers.find((h) => h.source === "/(.*)").headers;

function fakeAssets() {
  const seen = [];
  return {
    seen,
    async fetch(request) {
      seen.push(new URL(request.url).pathname);
      return new Response("<html>asset</html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
  };
}

const call = (path, init = {}, env = { ASSETS: fakeAssets() }) =>
  worker.fetch(new Request(`https://yeubep.shop${path}`, init), env);

test("every api/*.js file is routed and nothing else", () => {
  const files = readdirSync(new URL("../api/", import.meta.url)).filter((n) => n.endsWith(".js")).map((n) => n.slice(0, -3)).sort();
  assert.deepEqual(Object.keys(API_HANDLERS).sort(), files);
  for (const name of files) assert.equal(typeof API_HANDLERS[name], "function", name);
});

test("vercel.json security headers on static, api and 404 responses", async () => {
  for (const path of ["/admin.html", "/api/health", "/api/nope"]) {
    const res = await call(path, path === "/api/health" ? { method: "OPTIONS" } : {});
    for (const { key, value } of SECURITY) assert.equal(res.headers.get(key), value, `${path} ${key}`);
  }
});

test("/?course= redirects like Vercel and keeps the query string", async () => {
  let res = await call("/?course=abc&x=1");
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("location"), "/course-gate.html?course=abc&x=1");
  res = await call("/?course=a%20b");
  assert.equal(res.headers.get("location"), "/course-gate.html?course=a%20b");
});

test("/ and /?course= (empty) serve index.html; other paths go to assets unchanged", async () => {
  const env = { ASSETS: fakeAssets() };
  for (const path of ["/", "/?course=", "/admin.html", "/admin", "/package.json"]) await call(path, {}, env);
  assert.deepEqual(env.ASSETS.seen, ["/index.html", "/index.html", "/admin.html", "/admin", "/package.json"]);
});

test("unknown or nested /api paths are 404 and never reach assets", async () => {
  const env = { ASSETS: fakeAssets() };
  for (const path of ["/api/nope", "/api/", "/api/orders/x", "/api/ORDERS", "/api/__proto__", "/api/constructor"]) {
    const res = await call(path, {}, env);
    assert.equal(res.status, 404, path);
  }
  assert.deepEqual(env.ASSETS.seen, []);
});

test("api handler runs through the adapter (health OPTIONS, no DB)", async () => {
  const res = await call("/api/health/", { method: "OPTIONS" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-methods"), "GET, OPTIONS");
});

test("host routing still fails closed when the tenant DB is unreachable", async () => {
  const res = await call("/api/orders");
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, "resolver_error");
});

test("request body over the Vercel 4.5 MB limit is 413 and the handler is not called", async () => {
  const original = API_HANDLERS.register;
  let called = false;
  API_HANDLERS.register = () => { called = true; };
  try {
    const res = await route(new Request("https://yeubep.shop/api/register", {
      method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(MAX_BODY_BYTES + 1)
    }), { ASSETS: fakeAssets() });
    assert.equal(res.status, 413);
    assert.equal(called, false);
  } finally {
    API_HANDLERS.register = original;
  }
});

test("handler sees the real host and query; spoofable forwarding headers are dropped", async () => {
  const original = API_HANDLERS.hero;
  let seen;
  API_HANDLERS.hero = (req, res) => { seen = req; res.status(200).json({ ok: true }); };
  try {
    const res = await call("/api/hero?course=a&course=b", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
      body: JSON.stringify({ a: 1 })
    });
    assert.equal(res.status, 200);
    assert.equal(seen.headers.host, "yeubep.shop");
    assert.equal(seen.headers["x-forwarded-host"], undefined);
    assert.equal(seen.headers["x-forwarded-proto"], undefined);
    assert.deepEqual(seen.query.course, ["a", "b"]);
    assert.deepEqual(seen.body, { a: 1 });
  } finally {
    API_HANDLERS.hero = original;
  }
});

test("worker source is never a static asset: assets dir is public/ and the build copies only root pages", async () => {
  const toml = readFileSync(new URL("../cloudflare/commerce-worker/wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /\[assets\][^[]*directory = "public"/);
  assert.match(toml, /run_worker_first = true/);
  assert.match(toml, /workers_dev = false/);
  assert.doesNotMatch(toml, /^routes\s*=/m);
  const { buildPublic } = await import("../scripts/build-vercel-public.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const out = mkdtempSync(path.join(tmpdir(), "cfw-"));
  try {
    const files = buildPublic(path.resolve(import.meta.dirname, ".."), out);
    assert.ok(files.length > 0 && files.every((f) => /^[A-Za-z0-9._-]+\.html$|^(favicon\.ico|robots\.txt)$/.test(f)), files.join(","));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
