/**
 * test/multi-agency-b7.test.js
 *
 * Milestone B7 Verification Test Suite:
 * - B7.1-UI-CONTRACT: Multi-surface UI variant contracts across all 6 surfaces
 * - B7.2-NO-BUSINESS-CORE-FORK: Radical layout differentiation without forking business core
 * - B7.3-HOMEWORK-MVP-LIFECYCLE: Submit, evaluate, grade, feedback with active entitlement requirement
 * - B7.4-CROSS-TENANT-HOMEWORK-DENIED: Cross-tenant homework access & grading strictly denied
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UI_SURFACES,
  UI_VARIANTS,
  DEFAULT_DESIGN_TOKENS,
  getSupportedVariants,
  resolveSurfaceVariant,
  renderVariantLayout
} from "../utils/ui-variant-engine.js";
import {
  submitAgencyHomework,
  gradeAgencyHomework,
  listAgencyHomework
} from "../utils/agency-homework.js";

test("B7.1-UI-CONTRACT: Multi-surface UI variant contracts across all 6 surfaces", () => {
  const surfaces = [
    UI_SURFACES.STOREFRONT,
    UI_SURFACES.CHECKOUT,
    UI_SURFACES.ADMIN,
    UI_SURFACES.LEARNER,
    UI_SURFACES.LEARNING,
    UI_SURFACES.HOMEWORK
  ];

  // 1. Every surface must have at least 1 default and 1 alternate
  for (const s of surfaces) {
    const supported = getSupportedVariants(s);
    assert.ok(supported.length >= 2, `Surface ${s} must have at least 2 variants`);
    assert.ok(supported.includes(UI_VARIANTS[s].DEFAULT), `Surface ${s} must include default`);
  }

  // 2. Profile resolution resolves defaults when profile is empty
  const defaultProfile = {};
  const storefrontResolved = resolveSurfaceVariant(defaultProfile, UI_SURFACES.STOREFRONT);
  assert.equal(storefrontResolved.variant, "classic_culinary");
  assert.equal(storefrontResolved.isDefault, true);
  assert.equal(storefrontResolved.designTokens.primaryColor, DEFAULT_DESIGN_TOKENS.primaryColor);

  // 3. Profile resolution respects custom variant & custom design tokens
  const agencyBProfile = {
    brand_name: "Culinary Modern",
    storefront_variant: "modern_grid",
    checkout_variant: "multi_step_express",
    design_tokens: {
      primaryColor: "#2563eb",
      borderRadius: "16px"
    }
  };
  const bStorefront = resolveSurfaceVariant(agencyBProfile, UI_SURFACES.STOREFRONT);
  assert.equal(bStorefront.variant, "modern_grid");
  assert.equal(bStorefront.isDefault, false);
  assert.equal(bStorefront.designTokens.primaryColor, "#2563eb");
  assert.equal(bStorefront.designTokens.borderRadius, "16px");

  // 4. Invalid variant falls back safely to default
  const invalidProfile = { storefront_variant: "non_existent_crazy_layout" };
  const fallbackResolved = resolveSurfaceVariant(invalidProfile, UI_SURFACES.STOREFRONT);
  assert.equal(fallbackResolved.variant, "classic_culinary");
  assert.equal(fallbackResolved.isDefault, true);
});

test("B7.2-NO-BUSINESS-CORE-FORK: Radical layout differentiation without altering business core", () => {
  const canonicalBusinessPayload = {
    courses: [
      { id: "c1", title: "Phở Bò Gia Truyền", priceVnd: 499000, difficulty: "intermediate" },
      { id: "c2", title: "Bánh Mì Sài Gòn", priceVnd: 399000, difficulty: "beginner" }
    ],
    hero: { title: "Nghệ Thuật Bếp Việt", subtitle: "Khóa học độc quyền" }
  };

  // Render variant 1: classic_culinary
  const layoutClassic = renderVariantLayout(
    UI_SURFACES.STOREFRONT,
    "classic_culinary",
    canonicalBusinessPayload
  );

  // Render variant 2: modern_grid
  const layoutModern = renderVariantLayout(
    UI_SURFACES.STOREFRONT,
    "modern_grid",
    canonicalBusinessPayload
  );

  // Structural layouts must differ significantly
  assert.equal(layoutClassic.layout, "classic_culinary");
  assert.equal(layoutClassic.structure, "vertical_story");
  assert.equal(layoutClassic.sections[0].type, "featured_course_list");

  assert.equal(layoutModern.layout, "modern_grid");
  assert.equal(layoutModern.structure, "css_grid_responsive");
  assert.equal(layoutModern.gridColumns, 3);
  assert.equal(layoutModern.sections[0].type, "catalog_grid");

  // CRITICAL: Both consume the exact same business courses without mutation
  assert.deepEqual(layoutClassic.sections[0].items, canonicalBusinessPayload.courses);
  assert.deepEqual(layoutModern.sections[0].items, canonicalBusinessPayload.courses);
});

test("B7.3-HOMEWORK-MVP-LIFECYCLE: Submit, evaluate, grade, feedback with entitlement requirement", async () => {
  const tenantA = { agencyId: "11111111-1111-1111-1111-111111111111", slug: "agency-a" };
  const studentMember = {
    id: "m-stud-1",
    agency_id: tenantA.agencyId,
    role: "student",
    status: "active"
  };
  const staffMember = {
    id: "m-staff-1",
    agency_id: tenantA.agencyId,
    role: "agency_staff",
    status: "active"
  };

  const courseId = "course-culinary-101";
  const lessonId = "lesson-knife-skills";

  // Mock DB store
  const dbStore = {
    entitlements: [
      {
        id: "ent-1",
        agency_id: tenantA.agencyId,
        membership_id: studentMember.id,
        canonical_course_id: courseId,
        status: "active",
        expires_at: null
      }
    ],
    homework: []
  };

  const mockDbClient = {
    from(table) {
      if (table === "student_entitlements") {
        return {
          select() {
            return {
              eq(col1, val1) {
                return {
                  eq(col2, val2) {
                    return {
                      eq(col3, val3) {
                        return {
                          eq(col4, val4) {
                            return {
                              async maybeSingle() {
                                const found = dbStore.entitlements.find(
                                  (e) =>
                                    e.agency_id === val1 &&
                                    e.membership_id === val2 &&
                                    e.canonical_course_id === val3 &&
                                    e.status === val4
                                );
                                return { data: found || null, error: null };
                              }
                            };
                          }
                        };
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
      if (table === "agency_homework_submissions") {
        return {
          insert(payload) {
            return {
              select() {
                return {
                  single() {
                    const row = { id: `hw-${Date.now()}`, ...payload };
                    dbStore.homework.push(row);
                    return { data: row, error: null };
                  }
                };
              }
            };
          },
          update(patch) {
            return {
              eq(col1, val1) {
                return {
                  eq(col2, val2) {
                    return {
                      select() {
                        return {
                          single() {
                            const item = dbStore.homework.find(
                              (h) => h.id === val1 && h.agency_id === val2
                            );
                            if (!item) return { data: null, error: new Error("Not found") };
                            Object.assign(item, patch);
                            return { data: item, error: null };
                          }
                        };
                      }
                    };
                  }
                };
              }
            };
          },
          select() {
            return {
              eq(col1, val1) {
                return {
                  eq(col2, val2) {
                    return {
                      order() {
                        const items = dbStore.homework.filter((h) => {
                          if (col1 === "agency_id" && h.agency_id !== val1) return false;
                          if (col2 === "membership_id" && h.membership_id !== val2) return false;
                          return true;
                        });
                        return { data: items, error: null };
                      }
                    };
                  },
                  order() {
                    const items = dbStore.homework.filter(
                      (h) => col1 === "agency_id" && h.agency_id === val1
                    );
                    return { data: items, error: null };
                  }
                };
              }
            };
          }
        };
      }
      throw new Error(`Unhandled table: ${table}`);
    }
  };

  // 1. Submit homework by entitled student -> SUCCESS
  const submission = await submitAgencyHomework({
    tenant: tenantA,
    membership: studentMember,
    courseId,
    lessonId,
    title: "Món Phở Hoàn Chỉnh",
    content: { photoUrl: "https://r2.cdn.internal/pho.jpg", note: "Nước dùng trong, bò mềm" },
    dbClient: mockDbClient
  });

  assert.ok(submission.id, "Submission should have ID");
  assert.equal(submission.status, "submitted");
  assert.equal(submission.agency_id, tenantA.agencyId);

  // 2. Unentitled student attempt -> REJECTED (403)
  const unentitledMember = {
    id: "m-stud-unentitled",
    agency_id: tenantA.agencyId,
    role: "student",
    status: "active"
  };
  await assert.rejects(
    async () => {
      await submitAgencyHomework({
        tenant: tenantA,
        membership: unentitledMember,
        courseId,
        lessonId,
        title: "Unauthorized test",
        dbClient: mockDbClient
      });
    },
    (err) => err.code === "entitlement_required" && err.status === 403
  );

  // 3. Staff grades submission -> SUCCESS
  const graded = await gradeAgencyHomework({
    tenant: tenantA,
    staffMembership: staffMember,
    submissionId: submission.id,
    status: "evaluated",
    score: 9.5,
    feedback: "Nước dùng rất chuẩn vị Hà Nội. Trình bày đẹp mắt!",
    dbClient: mockDbClient
  });

  assert.equal(graded.status, "evaluated");
  assert.equal(graded.staff_score, 9.5);
  assert.equal(graded.staff_feedback, "Nước dùng rất chuẩn vị Hà Nội. Trình bày đẹp mắt!");
  assert.equal(graded.reviewed_by_membership_id, staffMember.id);

  // 4. Student list submissions -> returns only own submission
  const studentList = await listAgencyHomework({
    tenant: tenantA,
    membership: studentMember,
    dbClient: mockDbClient
  });
  assert.equal(studentList.length, 1);
  assert.equal(studentList[0].id, submission.id);
});

test("B7.4-CROSS-TENANT-HOMEWORK-DENIED: Cross-tenant submission and grading strictly denied", async () => {
  const tenantA = { agencyId: "11111111-1111-1111-1111-111111111111", slug: "agency-a" };
  const tenantB = { agencyId: "22222222-2222-2222-2222-222222222222", slug: "agency-b" };

  const memberAgencyB = {
    id: "m-b-1",
    agency_id: tenantB.agencyId,
    role: "student",
    status: "active"
  };

  const staffAgencyB = {
    id: "m-b-staff",
    agency_id: tenantB.agencyId,
    role: "agency_staff",
    status: "active"
  };

  // Cross-tenant submit on tenant A using membership B -> REJECTED
  await assert.rejects(
    async () => {
      await submitAgencyHomework({
        tenant: tenantA,
        membership: memberAgencyB,
        courseId: "c-1",
        lessonId: "l-1",
        title: "Spoofing attempt",
        dbClient: {}
      });
    },
    /Membership does not belong to current tenant/
  );

  // Cross-tenant grading on tenant A using staff B -> REJECTED
  await assert.rejects(
    async () => {
      await gradeAgencyHomework({
        tenant: tenantA,
        staffMembership: staffAgencyB,
        submissionId: "hw-1",
        status: "evaluated",
        score: 10,
        feedback: "Cross tenant spoof",
        dbClient: {}
      });
    },
    /Staff membership does not belong to current tenant/
  );
});
