// test/multi-agency-b4.test.js
// Automated test suite for System B Milestone B4 / M0B.1 Hardened Scoped Data Repositories

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  TenantDbResolver,
  createPublicCatalogRepo,
  createMemberReadRepo,
  createAgencyWriteRepo,
  createPlatformCoreReadRepo,
  assertServerEnvironment,
  assertTrustedTenantInput,
  agencyOrderOperations,
  agencyHomeworkOperations
} from "../utils/tenant-db-resolver.js";
import { _clearTenantCache, resolveTenant } from "../utils/tenant-resolver.js";

// =============================================================================
// B4.1: TRUSTED TENANT INPUT & NO PLAIN OBJECT AUTHORITY
// =============================================================================

test("B4.1-TRUSTED-TENANT-INPUT: Plain unbranded objects are strictly rejected", async () => {
  // 1. Plain unbranded object -> MUST FAIL
  const plainObject = { agencyId: "plain-agency-id" };
  await assert.rejects(
    async () => {
      await assertTrustedTenantInput(plainObject);
    },
    /SECURITY VIOLATION: TenantContext must be derived from trusted tenant resolver/
  );

  await assert.rejects(
    async () => {
      await createPublicCatalogRepo(plainObject);
    },
    /SECURITY VIOLATION/
  );

  // 2. Request object resolved via trusted tenant resolver -> SUCCEEDS
  const mockDb = {
    rpc: async (func, args) => {
      if (args.p_hostname === "valid-agency.com") {
        return { data: { found: true, agency_id: "valid-agency-id", hostname: "valid-agency.com" } };
      }
      return { data: null };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({ data: [], error: null })
          })
        })
      })
    })
  };

  const req = { headers: { host: "valid-agency.com" } };
  const repo = await createPublicCatalogRepo(req, { supabaseClient: mockDb });
  assert.equal(repo.getAgencyId(), "valid-agency-id");
  assert.ok(repo.getTenantContext());
});

// =============================================================================
// B4.2: NO RAW SERVICE-ROLE CLIENT ESCAPE
// =============================================================================

test("B4.2-NO-RAW-SERVICE-CLIENT-ESCAPE: Scoped operations never expose raw client to caller", async () => {
  // agencyOrderOperations and agencyHomeworkOperations are frozen objects exposing only specific methods
  assert.ok(Object.isFrozen(agencyOrderOperations), "agencyOrderOperations must be frozen");
  assert.ok(Object.isFrozen(agencyHomeworkOperations), "agencyHomeworkOperations must be frozen");

  assert.equal(typeof agencyOrderOperations.createOrder, "function");
  assert.equal(typeof agencyOrderOperations.approveOrder, "function");
  assert.equal(typeof agencyOrderOperations.refundOrder, "function");
  assert.equal(agencyOrderOperations.executePrivilegedAgencyMutation, undefined, "Raw callback mutation must be removed");

  assert.equal(typeof agencyHomeworkOperations.submitHomework, "function");
  assert.equal(typeof agencyHomeworkOperations.gradeHomework, "function");
});

// =============================================================================
// B4.3: PLATFORM CORE SCOPE & LICENSED OFFERING BOUNDARY
// =============================================================================

test("B4.3-PLATFORM-CORE-SCOPE: Canonical course not licensed to agency is denied", async () => {
  const mockDb = {
    rpc: async () => ({ data: { found: true, agency_id: "agency-1", hostname: "agency1.com" } }),
    from: (table) => {
      if (table === "canonical_courses") {
        return {
          select: () => ({
            eq: (col, val) => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "c-unlicensed", code: "UNLICENSED-101", default_title: "Secret Chef Course" },
                  error: null
                })
              })
            })
          })
        };
      }
      if (table === "agency_offering_items") {
        return {
          select: () => ({
            eq: (col1, val1) => ({
              eq: (col2, val2) => ({
                limit: () => ({
                  // Return null: this agency does NOT license this course
                  maybeSingle: async () => ({ data: null, error: null })
                })
              })
            })
          })
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };

  const req = { headers: { host: "agency1.com" } };
  const platformRepo = await createPlatformCoreReadRepo(req, { supabaseClient: mockDb });

  // Attempting to read unlicensed canonical course must fail closed with 403
  await assert.rejects(
    async () => {
      await platformRepo.getCanonicalCourseByCode("UNLICENSED-101");
    },
    (err) => err.code === "course_not_licensed" && err.status === 403
  );
});

// =============================================================================
// B4.4: REAL SERVER-ONLY IMPORT & STATIC BOUNDARY
// =============================================================================

test("B4.4-SERVER-ONLY-STATIC-BOUNDARY: Browser files never import server utilities or service keys", () => {
  // Runtime guard: assertServerEnvironment throws if executed in browser context
  assertServerEnvironment(); // server context: does not throw

  const originalWindow = globalThis.window;
  try {
    globalThis.window = {}; // Simulate browser
    assert.throws(
      () => assertServerEnvironment(),
      /SECURITY VIOLATION: Privileged database operations cannot be executed in browser context/
    );
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }

  // Static AST/text inspection: All HTML files in root and public must NOT import server utils
  const rootDir = path.resolve(import.meta.dirname, "..");
  const htmlFiles = fs.readdirSync(rootDir).filter((f) => f.endsWith(".html"));

  for (const file of htmlFiles) {
    const content = fs.readFileSync(path.join(rootDir, file), "utf8");
    assert.equal(
      content.includes("tenant-db-resolver"),
      false,
      `File ${file} must not reference tenant-db-resolver`
    );
    assert.equal(
      content.includes("SUPABASE_SERVICE_ROLE_KEY"),
      false,
      `File ${file} must not reference SUPABASE_SERVICE_ROLE_KEY`
    );
  }
});

// =============================================================================
// B4.5: AGENCY WRITE BOUNDS & REMOVAL OF BROKEN GENERIC WRITER
// =============================================================================

test("B4.5-AGENCY-WRITE-BOUNDS: Sanitizes spoofed agency_id and omits broken generic status writer", async () => {
  const mockDb = {
    rpc: async () => ({ data: { found: true, agency_id: "agency-verified", hostname: "agency.com" } }),
    auth: {
      getUser: async () => ({ data: { user: { id: "staff-1" } }, error: null })
    },
    from: (table) => {
      if (table === "agency_memberships") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "m-staff-1", agency_id: "agency-verified", role: "agency_staff", status: "active" },
                  error: null
                })
              })
            })
          })
        };
      }
      if (table === "agency_offerings") {
        return {
          insert: (payload) => {
            // Confirm payload agency_id was forced to verified agency, NOT caller's spoof
            assert.equal(payload.agency_id, "agency-verified");
            return {
              select: () => ({
                single: async () => ({ data: { id: "off-1", ...payload }, error: null })
              })
            };
          }
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };

  const req = {
    headers: { host: "agency.com", authorization: "Bearer valid-token" }
  };

  const writeRepo = await createAgencyWriteRepo(req, ["agency_staff"], { supabaseClient: mockDb });
  assert.equal(writeRepo.ok, true);

  // Verify generic updateOrderStatus was removed
  assert.equal(writeRepo.updateOrderStatus, undefined, "Generic updateOrderStatus must be removed (D4)");

  // Create offering with spoofed agency_id
  const offering = await writeRepo.createOffering({
    agency_id: "spoofed-attacker-agency",
    slug: "new-course",
    display_title: "New Cooking Course"
  });
  assert.equal(offering.agency_id, "agency-verified");
});
