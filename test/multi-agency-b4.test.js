// test/multi-agency-b4.test.js
// Automated test suite for System B Milestone B4 TenantDbResolver & Scoped Data Repositories

import assert from "node:assert/strict";
import test from "node:test";
import {
  TenantDbResolver,
  createPublicCatalogRepo,
  createMemberReadRepo,
  createAgencyWriteRepo,
  createPlatformCoreReadRepo,
  assertServerEnvironment,
  executePrivilegedAgencyMutation
} from "../utils/tenant-db-resolver.js";
import { _clearTenantCache } from "../utils/tenant-resolver.js";

// =============================================================================
// B4.1: PUBLIC CATALOG REPO & CROSS-TENANT ISOLATION
// =============================================================================

test("B4.1-PUBLIC-CATALOG-ISOLATION: Tenant A cannot read Tenant B offerings", async () => {
  const tenantA = { agencyId: "agency-a-id", agencySlug: "agency-a", hostname: "agency-a.com" };
  const tenantB = { agencyId: "agency-b-id", agencySlug: "agency-b", hostname: "agency-b.com" };

  const mockDb = {
    from: (table) => ({
      select: () => ({
        eq: (col1, val1) => ({
          eq: (col2, val2) => ({
            order: () => {
              if (col1 === "agency_id" && val1 === "agency-a-id") {
                return {
                  data: [
                    { id: "offering-a1", agency_id: "agency-a-id", slug: "cooking-101", is_published: true }
                  ],
                  error: null
                };
              }
              if (col1 === "agency_id" && val1 === "agency-b-id") {
                return {
                  data: [
                    { id: "offering-b1", agency_id: "agency-b-id", slug: "baking-201", is_published: true }
                  ],
                  error: null
                };
              }
              return { data: [], error: null };
            }
          })
        })
      })
    })
  };

  const repoA = createPublicCatalogRepo(tenantA, { supabaseClient: mockDb });
  const repoB = createPublicCatalogRepo(tenantB, { supabaseClient: mockDb });

  const offeringsA = await repoA.getPublishedOfferings();
  const offeringsB = await repoB.getPublishedOfferings();

  assert.equal(offeringsA.length, 1);
  assert.equal(offeringsA[0].id, "offering-a1");
  assert.equal(offeringsA[0].agency_id, "agency-a-id");

  assert.equal(offeringsB.length, 1);
  assert.equal(offeringsB[0].id, "offering-b1");
  assert.equal(offeringsB[0].agency_id, "agency-b-id");

  // Verify A cannot see B
  assert.equal(offeringsA.some(o => o.agency_id === "agency-b-id"), false);
});

// =============================================================================
// B4.2: MEMBER READ REPO & MULTI-AGENCY HOST SCOPING
// =============================================================================

test("B4.2-MEMBER-REPO-HOST-SCOPED: Same user holding dual membership is strictly scoped by request host", async () => {
  _clearTenantCache();

  const mockDb = {
    rpc: async (func, args) => {
      if (args.p_hostname === "agency-a.com") {
        return { data: { found: true, agency_id: "agency-a-id", hostname: "agency-a.com" } };
      }
      if (args.p_hostname === "agency-b.com") {
        return { data: { found: true, agency_id: "agency-b-id", hostname: "agency-b.com" } };
      }
      return { data: null };
    },
    auth: {
      getUser: async () => ({
        data: { user: { id: "dual-user-1" } },
        error: null
      })
    },
    from: (table) => ({
      select: () => ({
        eq: (col1, val1) => ({
          eq: (col2, val2) => ({
            maybeSingle: async () => {
              if (table === "agency_memberships") {
                if (val2 === "agency-a-id") {
                  return {
                    data: {
                      id: "mem-a",
                      agency_id: "agency-a-id",
                      user_id: "dual-user-1",
                      role: "student",
                      display_name: "Student on A",
                      status: "active"
                    }
                  };
                }
                if (val2 === "agency-b-id") {
                  return {
                    data: {
                      id: "mem-b",
                      agency_id: "agency-b-id",
                      user_id: "dual-user-1",
                      role: "agency_staff",
                      display_name: "Staff on B",
                      status: "active"
                    }
                  };
                }
              }
              return { data: null };
            },
            order: () => {
              if (table === "agency_orders") {
                if (val2 === "mem-a") {
                  return { data: [{ id: "order-a1", amount_vnd: 500000 }], error: null };
                }
                if (val2 === "mem-b") {
                  return { data: [{ id: "order-b1", amount_vnd: 1200000 }], error: null };
                }
              }
              return { data: [], error: null };
            }
          })
        })
      })
    })
  };

  const reqA = { headers: { host: "agency-a.com", authorization: "Bearer valid_token" } };
  const reqB = { headers: { host: "agency-b.com", authorization: "Bearer valid_token" } };

  // Repo on Agency A host
  const repoA = await createMemberReadRepo(reqA, { supabaseClient: mockDb });
  assert.equal(repoA.ok, true);
  const profileA = await repoA.getMembershipProfile();
  assert.equal(profileA.agencyId, "agency-a-id");
  assert.equal(profileA.role, "student");
  const ordersA = await repoA.getMyOrders();
  assert.equal(ordersA[0].id, "order-a1");

  // Repo on Agency B host
  const repoB = await createMemberReadRepo(reqB, { supabaseClient: mockDb });
  assert.equal(repoB.ok, true);
  const profileB = await repoB.getMembershipProfile();
  assert.equal(profileB.agencyId, "agency-b-id");
  assert.equal(profileB.role, "agency_staff");
  const ordersB = await repoB.getMyOrders();
  assert.equal(ordersB[0].id, "order-b1");
});

// =============================================================================
// B4.3: AGENCY WRITE REPO & SPOOFED AGENCY_ID REJECTION
// =============================================================================

test("B4.3-AGENCY-WRITE-SANITIZE-SPOOF: Write repo forces agency_id from verified request tenant", async () => {
  _clearTenantCache();

  let capturedInsert = null;

  const mockDb = {
    rpc: async () => ({
      data: { found: true, agency_id: "agency-a-id", hostname: "agency-a.com" }
    }),
    auth: {
      getUser: async () => ({ data: { user: { id: "staff-user-1" } } })
    },
    from: (table) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "mem-staff",
                agency_id: "agency-a-id",
                user_id: "staff-user-1",
                role: "agency_staff",
                status: "active"
              }
            })
          })
        })
      }),
      insert: (payload) => ({
        select: () => ({
          single: async () => {
            capturedInsert = payload;
            return { data: { id: "new-offering-1", ...payload }, error: null };
          }
        })
      })
    })
  };

  const req = { headers: { host: "agency-a.com", authorization: "Bearer staff_token" } };
  const writeRepo = await createAgencyWriteRepo(req, ["agency_staff", "agency_owner"], { supabaseClient: mockDb });
  assert.equal(writeRepo.ok, true);

  // Attacker attempts to provide a spoofed agency_id: "agency-b-id" in the creation payload
  await writeRepo.createOffering({
    agency_id: "agency-b-id", // SPOOF ATTEMPT
    slug: "hacked-offering",
    display_title: "Hacked Title",
    price_vnd: 100000
  });

  // Verify that the repository strictly sanitized the payload and enforced agency-a-id
  assert.equal(capturedInsert.agency_id, "agency-a-id");
  assert.notEqual(capturedInsert.agency_id, "agency-b-id");
});

// =============================================================================
// B4.4: SERVICE ROLE BROWSER PROTECTION & PRIVILEGED MUTATION CONTRACT
// =============================================================================

test("B4.4-BROWSER-GUARD: assertServerEnvironment throws if executed in browser context", () => {
  // Simulate browser environment
  globalThis.window = {};
  assert.throws(() => {
    assertServerEnvironment();
  }, /SECURITY VIOLATION/);
  delete globalThis.window;
});

test("B4.4-PRIVILEGED-MUTATION-BOUNDS: executePrivilegedAgencyMutation bounds service execution by verified tenant", async () => {
  _clearTenantCache();

  const mockDb = {
    rpc: async () => ({
      data: { found: true, agency_id: "agency-a-id", hostname: "agency-a.com" }
    }),
    auth: {
      getUser: async () => ({ data: { user: { id: "owner-user" } } })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "mem-owner",
                agency_id: "agency-a-id",
                user_id: "owner-user",
                role: "agency_owner",
                status: "active"
              }
            })
          })
        })
      })
    })
  };

  const req = { headers: { host: "agency-a.com", authorization: "Bearer owner_token" } };

  let contractExecuted = false;
  let receivedTenant = null;

  const result = await executePrivilegedAgencyMutation(
    req,
    ["agency_owner"],
    async (client, tenant, user, membership) => {
      contractExecuted = true;
      receivedTenant = tenant;
      return { success: true };
    },
    { supabaseClient: mockDb }
  );

  assert.equal(result.ok, true);
  assert.equal(contractExecuted, true);
  assert.equal(receivedTenant.agencyId, "agency-a-id");
});

// =============================================================================
// B4.5: UNKNOWN TENANT FAILS CLOSED
// =============================================================================

test("B4.5-UNKNOWN-TENANT-DENIED: Member and write repos fail closed on unknown tenant host", async () => {
  _clearTenantCache();

  const mockDb = {
    rpc: async () => ({ data: null, error: null })
  };

  const reqUnknown = { headers: { host: "unknown-hacker.com", authorization: "Bearer token" } };

  const memberRepo = await createMemberReadRepo(reqUnknown, { supabaseClient: mockDb });
  assert.equal(memberRepo.ok, false);
  assert.equal(memberRepo.status, 404);
  assert.equal(memberRepo.code, "tenant_not_found");

  const writeRepo = await createAgencyWriteRepo(reqUnknown, ["agency_owner"], { supabaseClient: mockDb });
  assert.equal(writeRepo.ok, false);
  assert.equal(writeRepo.status, 404);
  assert.equal(writeRepo.code, "tenant_not_found");
});
