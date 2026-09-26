// test/b4-tenant-db-resolver.test.js
// Regression test suite for Phase 1: B4 Tenant DB Resolver Final Fix
// Verifies:
// 1. Plain {agencyId} is strictly rejected
// 2. Raw service-role client cannot be retrieved via TenantDbResolver.resolveDbClient
// 3. Licensed canonical course succeeds via agency_offering_items.canonical_course_id
// 4. Unlicensed canonical course denied with course_not_licensed
// 5. Linked lesson succeeds when course is licensed
// 6. Cross-tenant ID substitution is denied

import assert from "node:assert/strict";
import test from "node:test";
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

test("B4.FINAL-1: Plain {agencyId} rejected and cannot acquire DB authority", async () => {
  const plainObject = { agencyId: "00000000-0000-0000-0000-000000000001" };

  // Cannot pass plain object to assertTrustedTenantInput
  await assert.rejects(
    async () => {
      await assertTrustedTenantInput(plainObject);
    },
    /SECURITY VIOLATION: TenantContext must be derived from trusted tenant resolver/
  );

  // Cannot pass plain object to createPublicCatalogRepo
  await assert.rejects(
    async () => {
      await createPublicCatalogRepo(plainObject);
    },
    /SECURITY VIOLATION/
  );

  // Cannot pass plain object to createPlatformCoreReadRepo
  await assert.rejects(
    async () => {
      await createPlatformCoreReadRepo(plainObject);
    },
    /SECURITY VIOLATION/
  );
});

test("B4.FINAL-2: Raw service-role client cannot be retrieved", () => {
  // Calling resolveDbClient must throw security violation
  assert.throws(
    () => {
      TenantDbResolver.resolveDbClient();
    },
    /SECURITY VIOLATION: Generic resolveDbClient is prohibited/
  );

  assert.throws(
    () => {
      TenantDbResolver.resolveDbClient({ agencyId: "some-id" });
    },
    /SECURITY VIOLATION: Generic resolveDbClient is prohibited/
  );

  // No function or property on TenantDbResolver exports a client
  const descriptors = Object.getOwnPropertyDescriptors(TenantDbResolver);
  assert.equal(typeof descriptors.resolveDbClient.value, "function");
  // ensure no supabaseClient property exists
  assert.equal(TenantDbResolver.supabaseClient, undefined);
  assert.equal(TenantDbResolver.defaultSupabase, undefined);
});

test("B4.FINAL-3: Licensed canonical course succeeds and unlicensed is denied (canonical_course_id)", async () => {
  const agencyId = "11111111-1111-1111-1111-111111111111";
  const licensedCourseId = "22222222-2222-2222-2222-222222222222";
  const unlicensedCourseId = "33333333-3333-3333-3333-333333333333";

  // Mock DB simulating canonical_courses and agency_offering_items with canonical_course_id
  const mockDb = {
    rpc: async (func, args) => {
      if (func === "resolve_agency_domain" && args.p_hostname === "chef-academy.local") {
        return {
          data: {
            found: true,
            agency_id: agencyId,
            agency_slug: "chef-academy",
            agency_name: "Chef Academy",
            domain_id: "dom-1",
            domain_status: "active",
            is_primary: true
          },
          error: null
        };
      }
      return { data: null, error: null };
    },
    from: (table) => {
      if (table === "canonical_courses") {
        return {
          select: () => ({
            eq: (col1, val1) => ({
              eq: (col2, val2) => ({
                maybeSingle: async () => {
                  if (val1 === "PHO-BO") {
                    return {
                      data: {
                        id: licensedCourseId,
                        course_id: "v5-pho-bo",
                        code: "PHO-BO",
                        default_title: "Master Pho Bo",
                        status: "published"
                      },
                      error: null
                    };
                  }
                  if (val1 === "FRENCH-PASTRY") {
                    return {
                      data: {
                        id: unlicensedCourseId,
                        course_id: "v5-pastry",
                        code: "FRENCH-PASTRY",
                        default_title: "French Pastry Masterclass",
                        status: "published"
                      },
                      error: null
                    };
                  }
                  return { data: null, error: null };
                }
              })
            })
          })
        };
      }
      if (table === "agency_offering_items") {
        return {
          select: (fields) => ({
            eq: (col1, agencyVal) => ({
              eq: (col2, courseVal) => {
                // VERIFY QUERY USES canonical_course_id
                assert.equal(col2, "canonical_course_id", "PlatformCoreRead must query canonical_course_id (NOT canonical_id)");
                assert.equal(agencyVal, agencyId);
                return {
                  limit: () => ({
                    maybeSingle: async () => {
                      if (courseVal === licensedCourseId) {
                        return { data: { id: "item-licensed" }, error: null };
                      }
                      // Unlicensed course -> no row
                      return { data: null, error: null };
                    }
                  })
                };
              }
            })
          })
        };
      }
      if (table === "canonical_lessons") {
        return {
          select: () => ({
            eq: (col, val) => ({
              order: () => ({
                data: [
                  { id: "les-1", canonical_course_id: licensedCourseId, title: "Lesson 1: Broth", sort_order: 1 }
                ],
                error: null
              })
            })
          })
        };
      }
      throw new Error(`Unexpected table query: ${table}`);
    }
  };

  const req = { headers: { host: "chef-academy.local" } };
  const repo = await createPlatformCoreReadRepo(req, { supabaseClient: mockDb });

  // 1. Licensed canonical course -> SUCCEEDS
  const licensedCourse = await repo.getCanonicalCourseByCode("PHO-BO");
  assert.ok(licensedCourse);
  assert.equal(licensedCourse.id, licensedCourseId);
  assert.equal(licensedCourse.code, "PHO-BO");

  // 2. Unlicensed canonical course -> DENIED with course_not_licensed
  await assert.rejects(
    async () => {
      await repo.getCanonicalCourseByCode("FRENCH-PASTRY");
    },
    (err) => {
      assert.equal(err.code, "course_not_licensed");
      assert.equal(err.status, 403);
      return true;
    }
  );

  // 3. Linked lesson for licensed course -> SUCCEEDS
  const lessons = await repo.getCanonicalLessons(licensedCourseId);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].title, "Lesson 1: Broth");

  // 4. Lessons for unlicensed course -> DENIED
  await assert.rejects(
    async () => {
      await repo.getCanonicalLessons(unlicensedCourseId);
    },
    (err) => {
      assert.equal(err.code, "course_not_licensed");
      assert.equal(err.status, 403);
      return true;
    }
  );
});

test("B4.FINAL-4: Cross-tenant ID substitution denied", async () => {
  const agencyAId = "aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const agencyBId = "bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const courseAId = "cccccccc-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  const mockDb = {
    rpc: async (func, args) => {
      if (args.p_hostname === "agency-b.local") {
        return {
          data: {
            found: true,
            agency_id: agencyBId,
            agency_slug: "agency-b",
            agency_name: "Agency B",
            domain_id: "dom-b",
            domain_status: "active",
            is_primary: true
          }
        };
      }
      return { data: null };
    },
    from: (table) => {
      if (table === "canonical_courses") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: courseAId, code: "COURSE-A", status: "published" },
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
            eq: (col1, agencyVal) => ({
              eq: (col2, courseVal) => {
                // Must be queried with current agency (agencyBId)
                assert.equal(agencyVal, agencyBId);
                return {
                  limit: () => ({
                    maybeSingle: async () => {
                      // Agency B does NOT license Agency A's course
                      return { data: null, error: null };
                    }
                  })
                };
              }
            })
          })
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };

  // Request is addressed to Agency B
  const req = { headers: { host: "agency-b.local" } };
  const repo = await createPlatformCoreReadRepo(req, { supabaseClient: mockDb });

  // Attempting to access course licensed only to Agency A fails on Agency B
  await assert.rejects(
    async () => {
      await repo.getCanonicalCourseByCode("COURSE-A");
    },
    (err) => err.code === "course_not_licensed" && err.status === 403
  );
});
