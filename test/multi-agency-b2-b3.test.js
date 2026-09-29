// test/multi-agency-b2-b3.test.js
// Comprehensive test suite for System B Milestone B2.1 & B3.1 security specifications
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md

import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeHost,
  getTrustedHost,
  resolveTenant,
  isTrustedTenantContext,
  _clearTenantCache
} from "../utils/tenant-resolver.js";
import {
  extractAuthToken,
  requireAuthenticatedUser,
  requireAgencyMembership,
  requireAgencyRole
} from "../utils/agency-auth.js";

// =============================================================================
// BLOCKER 4: STRICT FULL AUTHORITY PARSING & PORT VALIDATION (B3.1)
// =============================================================================

test("B3.1-AUTH-VALID: Valid authorities normalize cleanly", () => {
  assert.equal(normalizeHost("agency.example"), "agency.example");
  assert.equal(normalizeHost("agency.example:443"), "agency.example");
  assert.equal(normalizeHost("AGENCY.EXAMPLE"), "agency.example");
  assert.equal(normalizeHost("agency.example."), "agency.example");
  assert.equal(normalizeHost("Cooking.Agency.VN:3000"), "cooking.agency.vn");
  assert.equal(normalizeHost("  ACADEMY.COM.  "), "academy.com");
  assert.equal(normalizeHost("sub.domain.test:8080"), "sub.domain.test");
  assert.equal(normalizeHost("localhost"), "localhost");
  assert.equal(normalizeHost("localhost:54321"), "localhost");
});

test("B3.1-AUTH-PORT-DENY: Malformed port values fail closed (Requirement 9)", () => {
  // Non-numeric port
  assert.equal(normalizeHost("agency.example:garbage"), null);
  // Multiple colons / extra parts
  assert.equal(normalizeHost("agency.example:443:bad"), null);
  assert.equal(normalizeHost("agency.example:443:extra"), null);
  // Port range violations
  assert.equal(normalizeHost("agency.example:0"), null);
  assert.equal(normalizeHost("agency.example:70000"), null);
  assert.equal(normalizeHost("agency.example:65536"), null);
  // Leading zeros or garbage suffixes
  assert.equal(normalizeHost("agency.example:0443"), null);
  assert.equal(normalizeHost("agency.example:443extra"), null);
});

test("B3.1-AUTH-SYNTAX-DENY: Malformed authority / URI / path / IPv6 fail closed", () => {
  assert.equal(normalizeHost("agency.example/path"), null);
  assert.equal(normalizeHost("https://agency.example"), null);
  assert.equal(normalizeHost("http://agency.example:3000"), null);
  assert.equal(normalizeHost("a.example,b.example"), null);
  assert.equal(normalizeHost("agency.example.."), null);
  assert.equal(normalizeHost("..agency.example"), null);
  assert.equal(normalizeHost("[::1]:8080"), null); // Fail closed on IPv6
  assert.equal(normalizeHost(""), null);
  assert.equal(normalizeHost("   "), null);
  assert.equal(normalizeHost(null), null);
  assert.equal(normalizeHost(undefined), null);
  assert.equal(normalizeHost(12345), null);
  assert.equal(normalizeHost("invalid_domain!"), null);
  assert.equal(normalizeHost("agency. example"), null); // Internal space
});

// =============================================================================
// BLOCKER 3: HOST AUTHORITY & FORWARDED HOST HANDLING (B3.1)
// =============================================================================

test("B3.1-HOST-AUTH: Host header is tenant authority (Requirement 6)", () => {
  // Case A: host valid, x-forwarded-host matches host => accept
  const reqMatching = {
    headers: {
      host: "agency-a.example",
      "x-forwarded-host": "agency-a.example"
    }
  };
  assert.equal(getTrustedHost(reqMatching), "agency-a.example");

  // Case B: host has port, x-forwarded-host has no port => both normalize to same host => accept
  const reqPort = {
    headers: {
      host: "agency-a.example:443",
      "x-forwarded-host": "agency-a.example"
    }
  };
  assert.equal(getTrustedHost(reqPort), "agency-a.example");

  // Case C: host valid, x-forwarded-host absent => resolve from host
  const reqAbsent = {
    headers: {
      host: "agency-a.example"
    }
  };
  assert.equal(getTrustedHost(reqAbsent), "agency-a.example");

  // Case D: host valid, x-forwarded-host present but empty string => DENY (Requirement 4)
  const reqEmptyForwarded = {
    headers: {
      host: "agency-a.example",
      "x-forwarded-host": ""
    }
  };
  assert.equal(getTrustedHost(reqEmptyForwarded), null);
});

test("B3.1-FORWARDED-CONFLICT: Conflicting forwarded host denied (Requirement 7)", () => {
  const reqConflict = {
    headers: {
      host: "agency-a.example",
      "x-forwarded-host": "agency-b.example"
    }
  };
  // Host = A, Forwarded = B => DENY
  assert.equal(getTrustedHost(reqConflict), null);
});

test("B3.1-FORWARDED-MALFORMED: Malformed forwarded host denied without silent fallback (Requirement 8)", () => {
  // If x-forwarded-host is present but malformed, fail closed
  const reqMalformed = {
    headers: {
      host: "agency-a.example",
      "x-forwarded-host": "garbage!#$%"
    }
  };
  assert.equal(getTrustedHost(reqMalformed), null);

  const reqComma = {
    headers: {
      host: "agency-a.example",
      "x-forwarded-host": "legit.com, attacker.com"
    }
  };
  assert.equal(getTrustedHost(reqComma), null);

  const reqPortGarbage = {
    headers: {
      host: "agency-a.example",
      "x-forwarded-host": "agency-a.example:garbage"
    }
  };
  assert.equal(getTrustedHost(reqPortGarbage), null);
});

test("B3.1-ARRAY-HEADERS-DENY: Multiple / array-valued Host or x-forwarded-host denied (Requirement 10)", () => {
  // Array host
  const reqArrayHost = {
    headers: {
      host: ["agency-a.example", "agency-b.example"]
    }
  };
  assert.equal(getTrustedHost(reqArrayHost), null);

  // Array forwarded host
  const reqArrayForwarded = {
    headers: {
      host: "agency-a.example",
      "x-forwarded-host": ["agency-a.example"]
    }
  };
  assert.equal(getTrustedHost(reqArrayForwarded), null);
});

test("B3.1-SPOOF-GUARD: Untrusted tenant headers have no effect (Requirement 13)", () => {
  const req = {
    headers: {
      host: "legit-agency.com",
      "x-agency-id": "00000000-0000-0000-0000-000000000099",
      "x-agency-slug": "spoofed-agency",
      "x-trusted-agency-id": "00000000-0000-0000-0000-000000000099",
      "x-tenant-id": "00000000-0000-0000-0000-000000000099"
    }
  };
  assert.equal(getTrustedHost(req), "legit-agency.com");
});

// =============================================================================
// TENANT RESOLVER DATABASE & CACHE INTEGRATION (B3.1)
// =============================================================================

test("B3.1-UNKNOWN-HOST: Unknown host fails closed (Requirement 11)", async () => {
  _clearTenantCache();
  const mockSupabase = {
    rpc: async () => ({ data: null, error: null })
  };
  const req = { headers: { host: "unknown-agency.com" } };
  const result = await resolveTenant(req, { supabaseClient: mockSupabase });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "tenant_not_found");
});

test("B3.1-INACTIVE-DOMAIN: Inactive domain/agency fails closed (Requirement 12)", async () => {
  _clearTenantCache();
  const mockSupabase = {
    rpc: async () => ({ data: { found: false }, error: null })
  };
  const req = { headers: { host: "suspended-agency.com" } };
  const result = await resolveTenant(req, { supabaseClient: mockSupabase });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "tenant_not_found");
});

test("B3.1-RESOLVE-ACTIVE: Valid active host resolves immutable trusted TenantContext", async () => {
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
  assert.equal(result.tenant.hostname, "cooking.agency.vn");
  // Verify unforgeable brand
  assert.equal(isTrustedTenantContext(result.tenant), true);
  // Verify immutability
  assert.throws(() => {
    result.tenant.agencyId = "tampered";
  });
});

test("B3.1-CACHE-ISOLATION: Tenant cache isolation prevents cross-tenant bleed", async () => {
  _clearTenantCache();
  const mockSupabase = {
    rpc: async (func, args) => {
      if (args.p_hostname === "agency-a.com") {
        return {
          data: {
            found: true,
            agency_id: "00000001-0000-0000-0000-000000000001",
            hostname: "agency-a.com"
          }
        };
      }
      if (args.p_hostname === "agency-b.com") {
        return {
          data: {
            found: true,
            agency_id: "00000001-0000-0000-0000-000000000002",
            hostname: "agency-b.com"
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
// BLOCKER 1: AUTH GUARD MUST BIND TENANT TO REQUEST (B2.1)
// =============================================================================

test("B2.1-FABRICATED-CONTEXT-DENY: Fabricated TenantContext cannot authorize (Requirement 1)", async () => {
  const req = {
    headers: {
      host: "agency-a.com",
      authorization: "Bearer valid_jwt_token"
    }
  };

  // Attacker crafts plain object with target agencyId
  const fabricatedContext = { agencyId: "00000001-0000-0000-0000-000000000099" };
  const result = await requireAgencyMembership(req, fabricatedContext);

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "untrusted_tenant_context");
});

test("B2.1-HOST-MISMATCH-DENY: TenantContext / request hostname mismatch denied (Requirement 2)", async () => {
  _clearTenantCache();
  // Validly resolved context for Agency B
  const mockSupabase = {
    rpc: async () => ({
      data: {
        found: true,
        agency_id: "agency-b-id",
        hostname: "agency-b.com"
      }
    })
  };

  const resB = await resolveTenant({ headers: { host: "agency-b.com" } }, { supabaseClient: mockSupabase });
  const validContextB = resB.tenant;
  assert.equal(isTrustedTenantContext(validContextB), true);

  // Now, attacker presents Agency B's valid context against a request routed to Agency A
  const reqToAgencyA = {
    headers: {
      host: "agency-a.com", // Request host is A!
      authorization: "Bearer valid_jwt_token"
    }
  };

  const result = await requireAgencyMembership(reqToAgencyA, validContextB, { supabaseClient: mockSupabase });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "tenant_host_mismatch");
});

test("B2.1-REAL-CONTEXT-ALLOWED: Real resolver context + matching request host allowed", async () => {
  _clearTenantCache();
  const mockSupabase = {
    rpc: async () => ({
      data: {
        found: true,
        agency_id: "agency-a-id",
        hostname: "agency-a.com"
      }
    }),
    auth: {
      getUser: async () => ({
        data: { user: { id: "user-123" } },
        error: null
      })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "mem-123",
                agency_id: "agency-a-id",
                user_id: "user-123",
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

  const req = {
    headers: {
      host: "agency-a.com",
      authorization: "Bearer valid_jwt_token"
    }
  };

  const tenantRes = await resolveTenant(req, { supabaseClient: mockSupabase });
  assert.equal(tenantRes.ok, true);

  const authRes = await requireAgencyMembership(req, tenantRes.tenant, { supabaseClient: mockSupabase });
  assert.equal(authRes.ok, true);
  assert.equal(authRes.membership.role, "student");
  assert.equal(authRes.tenant.agencyId, "agency-a-id");
});

test("B2.1-DUAL-AGENCY-HOST-SCOPE: Dual-agency user correctly scoped by request host (Requirement 3)", async () => {
  _clearTenantCache();

  // Multi-agency mock: user is student in A, agency_staff in B
  const mockSupabase = {
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

  const reqA = { headers: { host: "agency-a.com", authorization: "Bearer token" } };
  const reqB = { headers: { host: "agency-b.com", authorization: "Bearer token" } };

  // 1. On Agency A host -> User resolved to Agency A membership (student)
  const authA = await requireAgencyMembership(reqA, { supabaseClient: mockSupabase });
  assert.equal(authA.ok, true);
  assert.equal(authA.membership.role, "student");
  assert.equal(authA.tenant.agencyId, "agency-a-id");

  // Attempting staff action on Agency A host => DENIED
  const roleCheckA = await requireAgencyRole(reqA, ["agency_staff"], { supabaseClient: mockSupabase });
  assert.equal(roleCheckA.ok, false);
  assert.equal(roleCheckA.code, "forbidden_role");

  // 2. On Agency B host -> User resolved to Agency B membership (agency_staff)
  const authB = await requireAgencyMembership(reqB, { supabaseClient: mockSupabase });
  assert.equal(authB.ok, true);
  assert.equal(authB.membership.role, "agency_staff");
  assert.equal(authB.tenant.agencyId, "agency-b-id");

  // Attempting staff action on Agency B host => ALLOWED
  const roleCheckB = await requireAgencyRole(reqB, ["agency_staff"], { supabaseClient: mockSupabase });
  assert.equal(roleCheckB.ok, true);
  assert.equal(roleCheckB.membership.role, "agency_staff");
});

// =============================================================================
// BLOCKER 2: ROLE GUARD MUST FAIL CLOSED (B2.1)
// =============================================================================

test("B2.1-ROLE-ALLOWLIST-FAIL-CLOSED: Missing or empty role allowlist fails closed (Requirements 4, 5)", async () => {
  _clearTenantCache();
  const mockSupabase = {
    rpc: async () => ({
      data: { found: true, agency_id: "agency-a-id", hostname: "agency-a.com" }
    }),
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "mem-1",
                agency_id: "agency-a-id",
                user_id: "user-1",
                role: "agency_owner",
                status: "active"
              }
            })
          })
        })
      })
    })
  };

  const req = { headers: { host: "agency-a.com", authorization: "Bearer token" } };

  // Case 1: allowedRoles is undefined (Requirement 4)
  const resUndefined = await requireAgencyRole(req, undefined, { supabaseClient: mockSupabase });
  assert.equal(resUndefined.ok, false);
  assert.equal(resUndefined.status, 500);
  assert.equal(resUndefined.code, "invalid_role_configuration");

  // Case 2: allowedRoles is null (Requirement 4)
  const resNull = await requireAgencyRole(req, null, { supabaseClient: mockSupabase });
  assert.equal(resNull.ok, false);
  assert.equal(resNull.status, 500);
  assert.equal(resNull.code, "invalid_role_configuration");

  // Case 3: allowedRoles is empty array (Requirement 5)
  const resEmpty = await requireAgencyRole(req, [], { supabaseClient: mockSupabase });
  assert.equal(resEmpty.ok, false);
  assert.equal(resEmpty.status, 500);
  assert.equal(resEmpty.code, "invalid_role_configuration");

  // Case 4: allowedRoles is invalid type / empty string (Requirement 4)
  const resInvalid = await requireAgencyRole(req, "invalid_string", { supabaseClient: mockSupabase });
  assert.equal(resInvalid.ok, false);
  assert.equal(resInvalid.status, 500);
  assert.equal(resInvalid.code, "invalid_role_configuration");

  const resEmptyString = await requireAgencyRole(req, [""], { supabaseClient: mockSupabase });
  assert.equal(resEmptyString.ok, false);
  assert.equal(resEmptyString.status, 500);
  assert.equal(resEmptyString.code, "invalid_role_configuration");
});

test("B2.1-ROLE-ENFORCEMENT: Role permissions allow/deny strictly according to allowlist", async () => {
  _clearTenantCache();
  const createMock = (role) => ({
    rpc: async () => ({
      data: { found: true, agency_id: "agency-a-id", hostname: "agency-a.com" }
    }),
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "mem-1",
                agency_id: "agency-a-id",
                user_id: "user-1",
                role,
                status: "active"
              }
            })
          })
        })
      })
    })
  });

  const req = { headers: { host: "agency-a.com", authorization: "Bearer token" } };

  // 1. student + ['agency_staff'] => deny
  const studentClient = createMock("student");
  const resStudentStaff = await requireAgencyRole(req, ["agency_staff"], { supabaseClient: studentClient });
  assert.equal(resStudentStaff.ok, false);
  assert.equal(resStudentStaff.code, "forbidden_role");

  // 2. student + ['agency_owner'] => deny
  const resStudentOwner = await requireAgencyRole(req, ["agency_owner"], { supabaseClient: studentClient });
  assert.equal(resStudentOwner.ok, false);
  assert.equal(resStudentOwner.code, "forbidden_role");

  // 3. staff + ['agency_staff'] => allow
  const staffClient = createMock("agency_staff");
  const resStaff = await requireAgencyRole(req, ["agency_staff"], { supabaseClient: staffClient });
  assert.equal(resStaff.ok, true);
  assert.equal(resStaff.membership.role, "agency_staff");

  // 4. owner + ['agency_owner'] => allow
  const ownerClient = createMock("agency_owner");
  const resOwner = await requireAgencyRole(req, ["agency_owner"], { supabaseClient: ownerClient });
  assert.equal(resOwner.ok, true);
  assert.equal(resOwner.membership.role, "agency_owner");
});

// =============================================================================
// GLOBAL IDENTITY & MEMBERSHIP STATUS (B2.1)
// =============================================================================

test("B2.1-AUTH-NO-SESSION: Rejects missing session (AUTH_NO_SESSION = DENY)", async () => {
  const req = { headers: { host: "agency-a.com" } };
  const result = await requireAuthenticatedUser(req);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "unauthenticated");
});

test("B2.1-LEGACY-HMAC-DENIED: Rejects old legacy HMAC session token (OLD_HMAC_SESSION_ON_NEW_AGENCY_PATH = DENY)", async () => {
  const req = {
    headers: {
      host: "agency-a.com",
      cookie: "admin_session_token=fake_legacy_hmac_token_value"
    }
  };
  const result = await requireAuthenticatedUser(req);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "legacy_auth_rejected");
});

test("B2.1-EXPIRED-SESSION: Rejects expired or invalid Supabase JWT (AUTH_EXPIRED_SESSION = DENY)", async () => {
  const mockSupabase = {
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: "JWT expired" } })
    }
  };

  const req = {
    headers: {
      host: "agency-a.com",
      authorization: "Bearer expired_or_tampered_jwt"
    }
  };
  const result = await requireAuthenticatedUser(req, { supabaseClient: mockSupabase });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "invalid_session");
});

test("B2.1-MEMBERSHIP-SUSPENDED: Suspended membership is denied (MEMBER_SUSPENDED = DENY)", async () => {
  _clearTenantCache();
  const mockSupabase = {
    rpc: async () => ({ data: { found: true, agency_id: "agency-1", hostname: "agency-1.com" } }),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "mem-1",
                agency_id: "agency-1",
                user_id: "user-1",
                role: "student",
                status: "suspended"
              }
            })
          })
        })
      })
    })
  };

  const req = { headers: { host: "agency-1.com", authorization: "Bearer valid_jwt" } };
  const result = await requireAgencyMembership(req, { supabaseClient: mockSupabase });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "membership_suspended");
});

// =============================================================================
// B3.2 & B2.2 REGRESSION TESTS (WORK FINDINGS 1-5)
// =============================================================================

test("B3.2-EMPTY-OR-WHITESPACE-FORWARDED-HOST: Present-but-empty/whitespace/null/non-string x-forwarded-host fails closed (never falls back to host)", () => {
  // Empty string
  const reqEmpty = {
    headers: {
      host: "agency-a.example",
      "x-forwarded-host": ""
    }
  };
  assert.equal(getTrustedHost(reqEmpty), null);

  // Whitespace only
  const reqWhitespace = {
    headers: {
      host: "agency-a.example",
      "x-forwarded-host": "   "
    }
  };
  assert.equal(getTrustedHost(reqWhitespace), null);

  // Null
  const reqNull = {
    headers: {
      host: "agency-a.example",
      "x-forwarded-host": null
    }
  };
  assert.equal(getTrustedHost(reqNull), null);

  // Non-string (e.g. number or object)
  const reqNum = {
    headers: {
      host: "agency-a.example",
      "x-forwarded-host": 12345
    }
  };
  assert.equal(getTrustedHost(reqNum), null);
});

test("B2.2-UNKNOWN-ROLE-REJECTED: requireAgencyRole rejects any unknown role value (only student, agency_staff, agency_owner allowed)", async () => {
  _clearTenantCache();
  const mockSupabase = {
    rpc: async () => ({
      data: { found: true, agency_id: "agency-a-id", hostname: "agency-a.com" }
    }),
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "mem-1",
                agency_id: "agency-a-id",
                user_id: "user-1",
                role: "agency_owner",
                status: "active"
              }
            })
          })
        })
      })
    })
  };

  const req = { headers: { host: "agency-a.com", authorization: "Bearer token" } };

  // Unknown role 'admin'
  const resAdmin = await requireAgencyRole(req, ["admin"], { supabaseClient: mockSupabase });
  assert.equal(resAdmin.ok, false);
  assert.equal(resAdmin.status, 500);
  assert.equal(resAdmin.code, "invalid_role_configuration");

  // Unknown role 'superadmin'
  const resSuper = await requireAgencyRole(req, ["superadmin"], { supabaseClient: mockSupabase });
  assert.equal(resSuper.ok, false);
  assert.equal(resSuper.status, 500);
  assert.equal(resSuper.code, "invalid_role_configuration");

  // Valid role combined with unknown role
  const resMixed = await requireAgencyRole(req, ["student", "super_user"], { supabaseClient: mockSupabase });
  assert.equal(resMixed.ok, false);
  assert.equal(resMixed.status, 500);
  assert.equal(resMixed.code, "invalid_role_configuration");
});

test("B2.2-DOMAIN-REMAP-STALE-CONTEXT-DENIED: Retained TenantContext after same-host Agency A -> Agency B remap does not authorize Agency A", async () => {
  _clearTenantCache();

  // State 1: host 'remap.agency.vn' points to Agency A
  let currentDbAgencyId = "agency-a-id";
  const mockSupabase = {
    rpc: async (func, args) => {
      if (args.p_hostname === "remap.agency.vn") {
        return {
          data: {
            found: true,
            agency_id: currentDbAgencyId,
            agency_slug: currentDbAgencyId === "agency-a-id" ? "agency-a" : "agency-b",
            hostname: "remap.agency.vn"
          }
        };
      }
      return { data: null };
    },
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } })
    },
    from: () => ({
      select: () => ({
        eq: (col1, uid) => ({
          eq: (col2, agencyId) => ({
            maybeSingle: async () => {
              // User has active membership in Agency A ONLY
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
              return { data: null };
            }
          })
        })
      })
    })
  };

  const req = { headers: { host: "remap.agency.vn", authorization: "Bearer token" } };

  // Step 1: Resolve context at T0 for Agency A
  const resT0 = await resolveTenant(req, { supabaseClient: mockSupabase });
  assert.equal(resT0.ok, true);
  const oldTenantAContext = resT0.tenant;
  assert.equal(oldTenantAContext.agencyId, "agency-a-id");

  // Step 2: In the database, domain is now remapped to Agency B!
  _clearTenantCache();
  currentDbAgencyId = "agency-b-id";

  // Step 3: Presenting old retained context for Agency A on the same host must be REJECTED!
  const staleAttempt = await requireAgencyMembership(req, oldTenantAContext, { supabaseClient: mockSupabase });
  assert.equal(staleAttempt.ok, false);
  assert.equal(staleAttempt.status, 403);
  assert.equal(staleAttempt.code, "stale_tenant_context");

  // Step 4: Normal request to the host resolves current Agency B, where user has no membership -> denied
  const currentAttempt = await requireAgencyMembership(req, { supabaseClient: mockSupabase });
  assert.equal(currentAttempt.ok, false);
  assert.equal(currentAttempt.status, 403);
  assert.equal(currentAttempt.code, "membership_not_found");

  const currentResolution = await resolveTenant(req, { supabaseClient: mockSupabase });
  assert.equal(currentResolution.tenant.agencyId, "agency-b-id");
});

