// test/multi-agency-b2-b3.test.js
// Test suite for System B Milestone B2 & B3 security specifications

import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeHost,
  getTrustedHost,
  resolveTenant,
  _clearTenantCache
} from "../utils/tenant-resolver.js";
import {
  extractAuthToken,
  requireAuthenticatedUser,
  requireAgencyMembership,
  requireAgencyRole
} from "../utils/agency-auth.js";

// =============================================================================
// B3 TEST SUITE: HOST NORMALIZATION & TENANT RESOLUTION
// =============================================================================

test("B3.1: Host normalization cleans port, trailing dots, and lowercases", () => {
  assert.equal(normalizeHost("Cooking.Agency.VN:3000"), "cooking.agency.vn");
  assert.equal(normalizeHost("  ACADEMY.COM.  "), "academy.com");
  assert.equal(normalizeHost("sub.domain.test:8080."), "sub.domain.test");
  assert.equal(normalizeHost("localhost:54321"), "localhost");
});

test("B3.2: Malformed host format fails closed", () => {
  assert.equal(normalizeHost("invalid_domain!"), null);
  assert.equal(normalizeHost("https://domain.com"), null);
  assert.equal(normalizeHost(""), null);
  assert.equal(normalizeHost(null), null);
  assert.equal(normalizeHost(12345), null);
});

test("B3.3: Ambiguous forwarded host (comma-separated) fails closed (AMBIGUOUS_FORWARDED_HOST = DENY)", () => {
  // Comma-separated forwarded hosts indicates proxy chaining or header injection
  assert.equal(normalizeHost("legit.com, attacker.com"), null);
  assert.equal(normalizeHost("attacker.com, legit.com"), null);

  const req = {
    headers: {
      "x-forwarded-host": "legit.com, attacker.com",
      host: "legit.com"
    }
  };
  assert.equal(getTrustedHost(req), null);
});

test("B3.4: Host precedence: x-forwarded-host precedes host when single valid value", () => {
  const req = {
    headers: {
      "x-forwarded-host": "preview.agency.com:443",
      host: "internal-proxy.local"
    }
  };
  assert.equal(getTrustedHost(req), "preview.agency.com");
});

test("B3.5: Header spoof guards ignore all untrusted tenant headers (X_AGENCY_ID_SPOOF = NO EFFECT)", () => {
  const req = {
    headers: {
      host: "legit-agency.com",
      "x-agency-id": "00000000-0000-0000-0000-000000000099",
      "x-agency-slug": "spoofed-agency",
      "x-trusted-agency-id": "00000000-0000-0000-0000-000000000099",
      "x-tenant-id": "00000000-0000-0000-0000-000000000099"
    },
    query: { agency_id: "00000000-0000-0000-0000-000000000099" },
    body: { agency_id: "00000000-0000-0000-0000-000000000099" }
  };
  // Host must strictly be extracted from trusted host source; all spoof headers ignored
  assert.equal(getTrustedHost(req), "legit-agency.com");
});

test("B3.6: Tenant resolver fails closed on unknown or inactive host (UNKNOWN_HOST = DENY)", async () => {
  _clearTenantCache();

  const mockSupabase = {
    rpc: async (func, args) => {
      // Host not found in DB
      return { data: null, error: null };
    }
  };

  const req = { headers: { host: "unknown-agency.com" } };
  const result = await resolveTenant(req, { supabaseClient: mockSupabase });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "tenant_not_found");
});

test("B3.7: Inactive agency / inactive domain fails closed (INACTIVE_AGENCY = DENY, INACTIVE_DOMAIN = DENY)", async () => {
  _clearTenantCache();

  // RPC returns found: false or inactive
  const mockSupabase = {
    rpc: async (func, args) => {
      return { data: { found: false }, error: null };
    }
  };

  const req = { headers: { host: "suspended-agency.com" } };
  const result = await resolveTenant(req, { supabaseClient: mockSupabase });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "tenant_not_found");
});

test("B3.8: Valid active host resolves immutable TenantContext (VALID_ACTIVE_HOST = PASS)", async () => {
  _clearTenantCache();

  const mockSupabase = {
    rpc: async (func, args) => {
      if (args.p_hostname === "cooking.agency.vn") {
        return {
          data: {
            found: true,
            agency_id: "00000001-0000-0000-0000-000000000001",
            agency_slug: "cooking-agency",
            agency_name: "Cooking Academy",
            agency_status: "active",
            domain_id: "00000002-0000-0000-0000-000000000001",
            hostname: "cooking.agency.vn",
            is_primary: true,
            ssl_status: "active",
            domain_status: "active"
          },
          error: null
        };
      }
      return { data: null, error: null };
    }
  };

  const req = { headers: { host: "Cooking.Agency.VN:443" } };
  const result = await resolveTenant(req, { supabaseClient: mockSupabase, surface: "lms" });

  assert.equal(result.ok, true);
  assert.equal(result.tenant.agencyId, "00000001-0000-0000-0000-000000000001");
  assert.equal(result.tenant.agencySlug, "cooking-agency");
  assert.equal(result.tenant.hostname, "cooking.agency.vn");
  assert.equal(result.tenant.surface, "lms");

  // Verify immutability
  assert.throws(() => {
    result.tenant.agencyId = "tampered";
  });
});

test("B3.9: Cache isolation prevents cross-tenant bleed (HOST_CACHE_CROSS_TENANT_BLEED = DENY)", async () => {
  _clearTenantCache();

  const mockSupabase = {
    rpc: async (func, args) => {
      if (args.p_hostname === "agency-a.com") {
        return {
          data: {
            found: true,
            agency_id: "00000001-0000-0000-0000-000000000001",
            agency_slug: "agency-a",
            agency_name: "Agency A",
            hostname: "agency-a.com",
            domain_status: "active",
            ssl_status: "active"
          }
        };
      }
      if (args.p_hostname === "agency-b.com") {
        return {
          data: {
            found: true,
            agency_id: "00000001-0000-0000-0000-000000000002",
            agency_slug: "agency-b",
            agency_name: "Agency B",
            hostname: "agency-b.com",
            domain_status: "active",
            ssl_status: "active"
          }
        };
      }
      return { data: null };
    }
  };

  const resA = await resolveTenant({ headers: { host: "agency-a.com" } }, { supabaseClient: mockSupabase });
  const resB = await resolveTenant({ headers: { host: "agency-b.com" } }, { supabaseClient: mockSupabase });

  assert.equal(resA.tenant.agencyId, "00000001-0000-0000-0000-000000000001");
  assert.equal(resB.tenant.agencyId, "00000001-0000-0000-0000-000000000002");
  assert.notEqual(resA.tenant.agencyId, resB.tenant.agencyId);
});

// =============================================================================
// B2 TEST SUITE: GLOBAL IDENTITY & MEMBERSHIP AUTHORIZATION
// =============================================================================

test("B2.1: Authentication rejects missing session (AUTH_NO_SESSION = DENY)", async () => {
  const req = { headers: {} };
  const result = await requireAuthenticatedUser(req);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "unauthenticated");
});

test("B2.2: Rejects old legacy HMAC session token on new agency path (OLD_HMAC_SESSION_ON_NEW_AGENCY_PATH = DENY)", async () => {
  const req = {
    headers: {
      cookie: "admin_session_token=fake_legacy_hmac_token_value"
    }
  };
  const result = await requireAuthenticatedUser(req);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "legacy_auth_rejected");
});

test("B2.3: Rejects expired or invalid Supabase JWT (AUTH_EXPIRED_SESSION = DENY)", async () => {
  const mockSupabase = {
    auth: {
      getUser: async (token) => {
        return { data: { user: null }, error: { message: "JWT expired" } };
      }
    }
  };

  const req = {
    headers: {
      authorization: "Bearer expired_or_tampered_jwt"
    }
  };
  const result = await requireAuthenticatedUser(req, { supabaseClient: mockSupabase });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "invalid_session");
});

test("B2.4: Valid Supabase JWT resolves stable user principal (AUTH_VALID_USER = PASS)", async () => {
  const mockSupabase = {
    auth: {
      getUser: async (token) => {
        return {
          data: {
            user: {
              id: "00000002-0000-0000-0000-000000000001",
              email: "student@test.agency",
              user_metadata: { role: "agency_owner" } // Attacker attempts role spoofing in metadata
            }
          },
          error: null
        };
      }
    }
  };

  const req = { headers: { authorization: "Bearer valid_jwt_token" } };
  const result = await requireAuthenticatedUser(req, { supabaseClient: mockSupabase });

  assert.equal(result.ok, true);
  assert.equal(result.user.id, "00000002-0000-0000-0000-000000000001");
});

test("B2.5: Active membership in requested agency is allowed (MEMBER_ACTIVE = ALLOW)", async () => {
  const tenantContext = {
    agencyId: "00000001-0000-0000-0000-000000000001",
    agencySlug: "agency-1"
  };

  const mockSupabase = {
    auth: {
      getUser: async () => ({
        data: { user: { id: "00000002-0000-0000-0000-000000000001" } },
        error: null
      })
    },
    from: (table) => ({
      select: () => ({
        eq: (col1, val1) => ({
          eq: (col2, val2) => ({
            maybeSingle: async () => ({
              data: {
                id: "00000003-0000-0000-0000-000000000001",
                agency_id: tenantContext.agencyId,
                user_id: "00000002-0000-0000-0000-000000000001",
                role: "student",
                status: "active"
              },
              error: null
            })
          })
        })
      })
    })
  };

  const req = { headers: { authorization: "Bearer valid_jwt" } };
  const result = await requireAgencyMembership(req, tenantContext, { supabaseClient: mockSupabase });

  assert.equal(result.ok, true);
  assert.equal(result.membership.role, "student");
  assert.equal(result.membership.status, "active");
});

test("B2.6: Suspended membership is denied (MEMBER_SUSPENDED = DENY)", async () => {
  const tenantContext = { agencyId: "00000001-0000-0000-0000-000000000001" };

  const mockSupabase = {
    auth: {
      getUser: async () => ({
        data: { user: { id: "00000002-0000-0000-0000-000000000001" } }
      })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "00000003-0000-0000-0000-000000000001",
                agency_id: tenantContext.agencyId,
                user_id: "00000002-0000-0000-0000-000000000001",
                role: "student",
                status: "suspended"
              }
            })
          })
        })
      })
    })
  };

  const req = { headers: { authorization: "Bearer valid_jwt" } };
  const result = await requireAgencyMembership(req, tenantContext, { supabaseClient: mockSupabase });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "membership_suspended");
});

test("B2.7: Membership in wrong agency is denied (MEMBER_WRONG_AGENCY = DENY)", async () => {
  const tenantContext = { agencyId: "00000001-0000-0000-0000-000000000002" }; // Agency 2

  const mockSupabase = {
    auth: {
      getUser: async () => ({
        data: { user: { id: "00000002-0000-0000-0000-000000000001" } }
      })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              // User has no membership in Agency 2
              data: null,
              error: null
            })
          })
        })
      })
    })
  };

  const req = { headers: { authorization: "Bearer valid_jwt" } };
  const result = await requireAgencyMembership(req, tenantContext, { supabaseClient: mockSupabase });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "membership_not_found");
});

test("B2.8: Role enforcement: student denied admin action, staff allowed, owner allowed", async () => {
  const tenantContext = { agencyId: "00000001-0000-0000-0000-000000000001" };

  const createMock = (role) => ({
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: "user-1",
            user_metadata: { role: "agency_owner" } // Spoofed in metadata!
          }
        }
      })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "mem-1",
                agency_id: tenantContext.agencyId,
                user_id: "user-1",
                role, // Real role in database
                status: "active"
              }
            })
          })
        })
      })
    })
  });

  const req = { headers: { authorization: "Bearer token" } };

  // 1. Student attempting admin/staff action -> DENY (ROLE_STUDENT_ADMIN_ACTION = DENY)
  const studentClient = createMock("student");
  const studentRes = await requireAgencyRole(req, tenantContext, ["agency_staff", "agency_owner"], {
    supabaseClient: studentClient
  });
  assert.equal(studentRes.ok, false);
  assert.equal(studentRes.code, "forbidden_role");

  // 2. Staff attempting staff action -> ALLOW (ROLE_STAFF_ALLOWED_ACTION = ALLOW)
  const staffClient = createMock("agency_staff");
  const staffRes = await requireAgencyRole(req, tenantContext, ["agency_staff", "agency_owner"], {
    supabaseClient: staffClient
  });
  assert.equal(staffRes.ok, true);
  assert.equal(staffRes.membership.role, "agency_staff");

  // 3. Owner attempting owner action -> ALLOW (ROLE_OWNER_ALLOWED_ACTION = ALLOW)
  const ownerClient = createMock("agency_owner");
  const ownerRes = await requireAgencyRole(req, tenantContext, ["agency_owner"], {
    supabaseClient: ownerClient
  });
  assert.equal(ownerRes.ok, true);
  assert.equal(ownerRes.membership.role, "agency_owner");
});

test("B2.9: Multi-agency user scope: user can have student role in Agency A and staff in Agency B (USER_MULTI_AGENCY_MEMBERSHIP)", async () => {
  const agencyA = { agencyId: "agency-a-id" };
  const agencyB = { agencyId: "agency-b-id" };

  const multiAgencyMock = {
    auth: {
      getUser: async () => ({ data: { user: { id: "multi-user-1" } } })
    },
    from: () => ({
      select: () => ({
        eq: (col1, uid) => ({
          eq: (col2, agencyId) => ({
            maybeSingle: async () => {
              if (agencyId === "agency-a-id") {
                return {
                  data: {
                    id: "mem-a",
                    agency_id: "agency-a-id",
                    user_id: uid,
                    role: "student",
                    status: "active"
                  }
                };
              }
              if (agencyId === "agency-b-id") {
                return {
                  data: {
                    id: "mem-b",
                    agency_id: "agency-b-id",
                    user_id: uid,
                    role: "agency_staff",
                    status: "active"
                  }
                };
              }
              return { data: null };
            }
          })
        })
      })
    })
  };

  const req = { headers: { authorization: "Bearer token" } };

  // On Agency A host -> member is student (cannot do staff action)
  const resOnA = await requireAgencyRole(req, agencyA, ["agency_staff"], { supabaseClient: multiAgencyMock });
  assert.equal(resOnA.ok, false);
  assert.equal(resOnA.code, "forbidden_role");

  // On Agency B host -> member is staff (can do staff action!)
  const resOnB = await requireAgencyRole(req, agencyB, ["agency_staff"], { supabaseClient: multiAgencyMock });
  assert.equal(resOnB.ok, true);
  assert.equal(resOnB.membership.role, "agency_staff");
});
