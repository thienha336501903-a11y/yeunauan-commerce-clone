import test from "node:test";
import assert from "node:assert/strict";
import { _clearTenantCache, resolveTenant } from "../utils/tenant-resolver.js";

function db(surface) {
  return {
    rpc: async () => ({
      data: {
        found: true,
        agency_id: "11111111-1111-4111-8111-111111111111",
        agency_slug: "agency-b",
        agency_name: "Agency B",
        domain_id: "22222222-2222-4222-8222-222222222222",
        hostname: "b.example.com",
        surface,
        domain_status: "active",
        ssl_status: "active",
        is_primary: true
      },
      error: null
    })
  };
}

test("Typed Commerce host resolves on Commerce surface", async () => {
  _clearTenantCache();
  const out = await resolveTenant({headers:{host:"b.example.com"}}, {surface:"commerce",supabaseClient:db("commerce")});
  assert.equal(out.ok, true);
  assert.equal(out.tenant.domainSurface, "commerce");
});

test("Typed Commerce host fails closed on LMS surface", async () => {
  _clearTenantCache();
  const out = await resolveTenant({headers:{host:"b.example.com"}}, {surface:"lms",supabaseClient:db("commerce")});
  assert.equal(out.ok, false);
  assert.equal(out.code, "tenant_surface_mismatch");
  assert.equal(out.status, 404);
});

test("Historical untyped Agency host remains compatible", async () => {
  _clearTenantCache();
  const out = await resolveTenant({headers:{host:"a.example.com"}}, {surface:"commerce",supabaseClient:db(null)});
  assert.equal(out.ok, true);
  assert.equal(out.tenant.domainSurface, null);
});
