import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import registerHandler from "../api/register.js";
import ordersHandler from "../api/orders.js";
import { _clearTenantCache } from "../utils/tenant-resolver.js";

const AGENCY_ID = "7beaa964-aed4-4309-8889-0485c26aaaf3";
const MEMBERSHIP_ID = "edde3b53-ba6f-41ab-a927-6943472ab045";
const USER_ID = "5f7ca775-9c5c-4015-bc2b-fd07e18eba50";
const OFFERING_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function responseCapture() {
  const state = { status: 200, body: null, headers: {} };
  return {
    state,
    setHeader(name, value) { state.headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return state.headers[String(name).toLowerCase()]; },
    status(code) { state.status = code; return this; },
    json(body) { state.body = body; return body; }
  };
}

function queryBuilder(table, calls) {
  const filters = {};
  const builder = {
    select() { return builder; },
    eq(column, value) { filters[column] = value; return builder; },
    async maybeSingle() {
      if (table === "agency_memberships") {
        return {
          data: {
            id: MEMBERSHIP_ID,
            agency_id: AGENCY_ID,
            user_id: USER_ID,
            role: "student",
            display_name: "M0D Student",
            phone: null,
            status: "active",
            created_at: "2026-09-29T00:00:00.000Z"
          },
          error: null
        };
      }
      if (table === "agency_orders") {
        assert.equal(filters.id, ORDER_ID);
        assert.equal(filters.agency_id, AGENCY_ID);
        assert.equal(filters.membership_id, MEMBERSHIP_ID);
        return {
          data: {
            id: ORDER_ID,
            agency_id: AGENCY_ID,
            membership_id: MEMBERSHIP_ID,
            status: "pending",
            order_code: "ORD-M0D",
            total_amount_vnd: 199000,
            created_at: "2026-09-29T00:00:00.000Z"
          },
          error: null
        };
      }
      throw new Error(`Unexpected maybeSingle on ${table}`);
    }
  };
  return builder;
}

function makeDb() {
  const calls = [];
  return {
    calls,
    auth: {
      async getUser(token) {
        calls.push({ type: "auth.getUser", token });
        return {
          data: { user: { id: USER_ID, email: "mobile@example.com" } },
          error: null
        };
      }
    },
    async rpc(name, args) {
      calls.push({ type: "rpc", name, args });
      if (name === "resolve_agency_domain") {
        return {
          data: {
            found: true,
            agency_id: AGENCY_ID,
            agency_slug: "agency-a",
            agency_name: "Agency A Test Academy",
            domain_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            domain_status: "active",
            ssl_status: "active",
            is_primary: false
          },
          error: null
        };
      }
      if (name === "checkout_agency_offering") {
        assert.equal(args.p_agency_id, AGENCY_ID);
        assert.equal(args.p_membership_id, MEMBERSHIP_ID);
        assert.equal(args.p_offering_id, OFFERING_ID);
        assert.equal(args.p_bank_account_id, null);
        return {
          data: {
            ok: true,
            order_id: ORDER_ID,
            order_code: "ORD-M0D",
            status: "pending",
            amount_vnd: 199000,
            bank_code: "TEST",
            account_number: "000000",
            account_holder: "TEST ONLY",
            transfer_content: "ORD-M0D",
            idempotent: false
          },
          error: null
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
    from(table) {
      calls.push({ type: "from", table });
      if (["orders", "student_enrollments", "lesson_progress"].includes(table)) {
        throw new Error(`Legacy table must not be touched: ${table}`);
      }
      return queryBuilder(table, calls);
    }
  };
}

function req({ method, path = "", query = {}, body = {}, db }) {
  return {
    method,
    query,
    body,
    headers: {
      host: "m0d-commerce.example.test",
      authorization: "Bearer m0d-supabase-token"
    },
    __options: { supabaseClient: db },
    url: path
  };
}

test("M0D Agency checkout creates Main agency order without Legacy order/sync path", async () => {
  _clearTenantCache();
  const db = makeDb();
  const res = responseCapture();

  await registerHandler(
    req({ method: "POST", body: { offeringId: OFFERING_ID }, db }),
    res
  );

  assert.equal(res.state.status, 200);
  assert.equal(res.state.body.success, true);
  assert.equal(res.state.body.deliveryMode, "agency");
  assert.equal(res.state.body.order.orderId, ORDER_ID);
  assert.ok(db.calls.some(call => call.type === "rpc" && call.name === "checkout_agency_offering"));
  assert.equal(db.calls.some(call => call.type === "from" && call.table === "orders"), false);
  assert.equal(db.calls.some(call => call.type === "from" && call.table === "student_enrollments"), false);
});

test("M0D Agency order lookup is scoped by current agency and membership", async () => {
  _clearTenantCache();
  const db = makeDb();
  const res = responseCapture();

  await ordersHandler(
    req({ method: "GET", query: { id: ORDER_ID }, db }),
    res
  );

  assert.equal(res.state.status, 200);
  assert.equal(res.state.body.success, true);
  assert.equal(res.state.body.order.id, ORDER_ID);
  assert.equal(res.state.body.order.agency_id, AGENCY_ID);
  assert.equal(res.state.body.order.membership_id, MEMBERSHIP_ID);
  assert.equal(db.calls.some(call => call.type === "from" && call.table === "orders"), false);
});

test("M0D Agency Commerce static dispatch and session surface are present", () => {
  const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const storefront = fs.readFileSync(new URL("../agency-storefront.html", import.meta.url), "utf8");
  const session = fs.readFileSync(new URL("../api/agency-session.js", import.meta.url), "utf8");
  const register = fs.readFileSync(new URL("../api/register.js", import.meta.url), "utf8");
  const orders = fs.readFileSync(new URL("../api/orders.js", import.meta.url), "utf8");

  assert.match(index, /config\?\.agency\?\.id|config\?\.agency\.id|config\?\.agency/);
  assert.match(index, /agency-storefront\.html/);
  assert.match(storefront, /\/api\/agency-session/);
  assert.match(storefront, /\/api\/register/);
  assert.match(storefront, /\/api\/orders\?id=/);
  assert.match(session, /bridgeGoogleAccessTokenToSupabaseSession/);
  assert.match(register, /checkoutOffering/);
  assert.match(orders, /getAgencyOrder/);
  assert.doesNotMatch(
    register.slice(register.indexOf('routeDecision.route === "AGENCY"'), register.indexOf("try {")),
    /student_enrollments|SYSTEM1_URL|sync-helpers/
  );
});
