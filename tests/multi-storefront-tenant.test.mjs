import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCourseTenantFilter,
  buildCourseSalesUrl,
  effectiveSalesSite,
  getSalesSiteConfig,
  normalizeSalesSite,
  requireSalesSite
} from "../utils/sales-site.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFile(resolve(root, path), "utf8");

test("tenant allowlist and legacy default", () => {
  assert.equal(normalizeSalesSite(null), "yeunauan");
  assert.equal(effectiveSalesSite({ sales_site: null }), "yeunauan");
  assert.equal(requireSalesSite("yeubep"), "yeubep");
  assert.throws(() => requireSalesSite("attacker"), /không hợp lệ/);
  assert.equal(getSalesSiteConfig("yeubep").host, "yeubep.shop");
  assert.equal(buildCourseSalesUrl({ slug: "demo", sales_site: null }), "https://shop.yeunauan.live/?course=demo");
});

test("server query applies legacy OR only to yeunauan and strict equality to yeubep", () => {
  const calls = [];
  const query = {
    or(value) { calls.push(["or", value]); return this; },
    eq(field, value) { calls.push(["eq", field, value]); return this; }
  };
  applyCourseTenantFilter(query, "yeunauan");
  assert.deepEqual(calls.pop(), ["or", "sales_site.eq.yeunauan,sales_site.is.null"]);
  applyCourseTenantFilter(query, "yeubep");
  assert.deepEqual(calls.pop(), ["eq", "sales_site", "yeubep"]);
});

test("public and order APIs derive tenant server-side", async () => {
  const config = await read("api/config.js");
  const register = await read("api/register.js");
  assert.match(config, /getDeploymentSalesSite\(\)/);
  assert.match(config, /applyCourseTenantFilter/);
  assert.doesNotMatch(config, /req\.(body|query|headers).*sales_site/);
  assert.match(register, /getDeploymentSalesSite\(\)/);
  assert.match(register, /price_snapshot: courseRec\.price/);
  assert.match(register, /sales_host: siteConfig\.host/);
  assert.match(register, /idempotency_key: idempotencyKey/);
  assert.match(register, /\.eq\("active", true\)/);
  assert.doesNotMatch(register, /courseName \|\|/);
});

test("admin selector, persisted assertion and quick toggles preserve tenant", async () => {
  const admin = await read("admin.html");
  assert.match(admin, /WEBSITE BÁN HÀNG \*/i);
  assert.match(admin, /name="salesSite" value="yeunauan"/);
  assert.match(admin, /name="salesSite" value="yeubep"/);
  assert.match(admin, /data\?\.data\?\.sales_site === sales_site/);
  assert.ok((admin.match(/sales_site: course\.sales_site \|\| "yeunauan"/g) || []).length >= 3);
});

test("approve-all is tenant, slug and status scoped", async () => {
  const api = await read("api/approve-all.js");
  const ui = await read("orders.html");
  assert.match(api, /\.eq\("course_slug", course\)[\s\S]*\.eq\("status", "Chờ duyệt"\)[\s\S]*applyOrderTenantFilter\(updateQuery, salesSite\)/);
  assert.match(ui, /JSON\.stringify\(\{ course: courseSlug, sales_site: salesSite \}\)/);
  assert.match(ui, /order\.sales_site === 'yeubep' \? 'yeubep\.shop' : 'yeunauan\.live'/);
});

test("migration is idempotent, constrained, indexed and preserves global slug uniqueness", async () => {
  const migration = await read("migrations/20260725_multi_storefront_tenant.sql");
  const rollback = await read("migrations/20260725_multi_storefront_tenant_rollback.sql");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS sales_site/);
  assert.match(migration, /sales_site IN \('yeunauan', 'yeubep'\)/);
  assert.match(migration, /idx_orders_sales_site_idempotency/);
  assert.doesNotMatch(migration, /UPDATE\s+public\.courses/i);
  assert.doesNotMatch(migration, /DROP\s+(CONSTRAINT|INDEX).*slug/i);
  assert.match(rollback, /DROP COLUMN IF EXISTS sales_site/);
});

test("LMS sync payload remains tenant-agnostic", async () => {
  const sync = await read("utils/sync-helpers.js");
  assert.doesNotMatch(sync, /sales_site|salesSite|sourceSite/);
  assert.match(sync, /action: "syncCourse"/);
  assert.match(sync, /"syncEnrollment"/);
  assert.match(sync, /"revokeEnrollment"/);
});
