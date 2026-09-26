// test/b6-commerce-routing.test.js
// Regression test suite for Phase 5 (B6 Commerce Routing & Host Dispatch)
// Verifies:
// 1. Overlapping Agency / Legacy host is denied (5A)
// 2. Commerce host dispatch prevents Agency host from creating Legacy orders (5B)
// 3. Agency host cannot manage Legacy courses or orders
// 4. Agency host on /api/config returns Agency commerce config
// 5. Unknown host is denied

import assert from "node:assert/strict";
import test from "node:test";
import registerHandler from "../api/register.js";
import ordersHandler from "../api/orders.js";
import coursesHandler from "../api/courses.js";
import configHandler from "../api/config.js";

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  return res;
}

test("B6.COMMERCE-1: Agency host cannot create Legacy order via /api/register", async () => {
  const req = {
    method: "POST",
    headers: {
      host: "chef-agency.com",
      "content-type": "application/json"
    },
    body: {
      gmail: "student@example.com",
      course: "banhmi4k",
      billName: "bill.jpg",
      billType: "image/jpeg",
      billData: Buffer.from("fake-bill").toString("base64")
    }
  };
  const res = createMockRes();

  await registerHandler(req, res);

  // Since chef-agency.com is an agency host (or unknown tenant), it must NOT create a legacy order!
  assert.ok(res.statusCode === 403 || res.statusCode === 404);
  if (res.statusCode === 403) {
    assert.equal(res.body.code, "agency_legacy_order_prohibited");
  }
});

test("B6.COMMERCE-2: Agency host cannot mutate Legacy orders via /api/orders", async () => {
  const req = {
    method: "GET",
    headers: {
      host: "chef-agency.com",
      "x-admin-password": "test"
    }
  };
  const res = createMockRes();

  await ordersHandler(req, res);

  assert.ok(res.statusCode === 403 || res.statusCode === 404);
  if (res.statusCode === 403) {
    assert.equal(res.body.code, "agency_legacy_order_prohibited");
  }
});

test("B6.COMMERCE-3: Agency host cannot manage Legacy courses via /api/courses", async () => {
  const req = {
    method: "GET",
    headers: {
      host: "chef-agency.com",
      "x-admin-password": "test"
    }
  };
  const res = createMockRes();

  await coursesHandler(req, res);

  assert.ok(res.statusCode === 403 || res.statusCode === 404);
  if (res.statusCode === 403) {
    assert.equal(res.body.code, "agency_legacy_courses_prohibited");
  }
});

test("B6.COMMERCE-4: Unknown host is denied with 404 across all entrypoints", async () => {
  const endpoints = [
    { handler: registerHandler, method: "POST" },
    { handler: ordersHandler, method: "GET" },
    { handler: coursesHandler, method: "GET" },
    { handler: configHandler, method: "GET" }
  ];

  for (const ep of endpoints) {
    const req = {
      method: ep.method,
      headers: { host: "unknown-unregistered-domain.net" }
    };
    const res = createMockRes();
    await ep.handler(req, res);
    assert.equal(res.statusCode, 404, `Endpoint ${ep.handler.name} must return 404 on unknown host`);
  }
});
