import assert from "node:assert/strict";
import test from "node:test";

import heroHandler from "../api/hero.js";
import healthHandler from "../api/health.js";

const tenantDb = {
  rpc: async (_name, args) => ({
    data: args.p_hostname === "agency-m0d.example"
      ? { found: true, agency_id: "m0d-agency", agency_slug: "m0d", hostname: args.p_hostname }
      : null
  })
};

function response() {
  return {
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
    redirect(code, location) { this.statusCode = code; this.location = location; return this; }
  };
}

test("Agency storefront image request never queries the Legacy courses table", async () => {
  const req = {
    headers: { host: "agency-m0d.example" },
    query: { course: "donut" },
    __options: { supabaseClient: tenantDb }
  };
  const res = response();
  await heroHandler(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "agency_legacy_hero_prohibited");
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.location, undefined);
});

test("Agency health uses tenant resolution without the Legacy courses probe", async () => {
  const req = {
    method: "GET", headers: { host: "agency-m0d.example" }, query: {},
    __options: { supabaseClient: tenantDb }
  };
  const res = response();
  await healthHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.database, "ok");
});

test("Unmapped hosts do not reach either Legacy table reader", async () => {
  for (const handler of [heroHandler, healthHandler]) {
    const req = {
      method: "GET", headers: { host: "unmapped-m0d.example" }, query: {},
      __options: { supabaseClient: tenantDb }
    };
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, "tenant_not_found");
    assert.equal(res.location, undefined);
  }
});
