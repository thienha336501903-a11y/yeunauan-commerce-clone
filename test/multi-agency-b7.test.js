/**
 * test/multi-agency-b7.test.js
 *
 * Milestone B7 / M0B.1 Hardened Verification Test Suite:
 * - B7.1-UI-CONTRACT: Multi-surface UI variant contracts across all 6 surfaces
 * - B7.2-NO-BUSINESS-CORE-FORK: Radical layout differentiation without forking business core
 * - B7.3-HOMEWORK-MVP-LIFECYCLE: Submit, evaluate, grade, feedback with active entitlement requirement
 * - B7.4-CROSS-TENANT-HOMEWORK-DENIED: Cross-tenant homework access & grading strictly denied
 * - B7.5-STUDENT-CANNOT-GRADE: Role enforcement (student cannot grade homework)
 * - B7.6-INVALID-CANONICAL-LESSON-DENIED: Homework submission fails closed if lesson not in course
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

  for (const s of surfaces) {
    const supported = getSupportedVariants(s);
    assert.ok(supported.length >= 2, `Surface ${s} must have at least 2 variants`);
    assert.ok(supported.includes(UI_VARIANTS[s].DEFAULT), `Surface ${s} must include default`);
  }

  const defaultProfile = {};
  const storefrontResolved = resolveSurfaceVariant(defaultProfile, UI_SURFACES.STOREFRONT);
  assert.equal(storefrontResolved.variant, "classic_culinary");
  assert.equal(storefrontResolved.isDefault, true);
  assert.equal(storefrontResolved.designTokens.primaryColor, DEFAULT_DESIGN_TOKENS.primaryColor);

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

  const layoutClassic = renderVariantLayout(
    UI_SURFACES.STOREFRONT,
    "classic_culinary",
    canonicalBusinessPayload
  );

  const layoutModern = renderVariantLayout(
    UI_SURFACES.STOREFRONT,
    "modern_grid",
    canonicalBusinessPayload
  );

  assert.equal(layoutClassic.layout, "classic_culinary");
  assert.equal(layoutClassic.structure, "vertical_story");
  assert.equal(layoutClassic.sections[0].type, "featured_course_list");

  assert.equal(layoutModern.layout, "modern_grid");
  assert.equal(layoutModern.structure, "css_grid_responsive");
  assert.equal(layoutModern.gridColumns, 3);
  assert.equal(layoutModern.sections[0].type, "catalog_grid");

  assert.deepEqual(layoutClassic.sections[0].items, canonicalBusinessPayload.courses);
  assert.deepEqual(layoutModern.sections[0].items, canonicalBusinessPayload.courses);
});

import { _clearTenantCache, resolveTenant } from "../utils/tenant-resolver.js";

async function getTestTenantContext(hostname, agencyId) {
  _clearTenantCache();
  const mockDb = {
    rpc: async (func, args) => ({
      data: { found: true, agency_id: agencyId, hostname }
    })
  };
  const res = await resolveTenant({ headers: { host: hostname } }, { supabaseClient: mockDb });
  return res.tenant;
}

test("B7.3-HOMEWORK-MVP-LIFECYCLE: Submit, evaluate, grade, feedback with entitlement requirement", async () => {
  const tenantA = await getTestTenantContext("agency-a.com", "11111111-1111-1111-1111-111111111111");

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

  const courseId = "11111111-0000-0000-0000-000000000001";
  const lessonId = "22222222-0000-0000-0000-000000000002";

  const dbStore = {
    submissions: []
  };

  const mockDbClient = {
    rpc: async (func, args) => {
      if (func === "submit_agency_homework") {
        if (args.p_canonical_course_id !== courseId || args.p_canonical_lesson_id !== lessonId) {
          return { data: { success: false, code: "lesson_course_mismatch" } };
        }
        if (args.p_membership_id === "m-unentitled") {
          return { data: { success: false, code: "entitlement_required" } };
        }
        const row = {
          id: `hw-${Date.now()}`,
          agency_id: args.p_agency_id,
          membership_id: args.p_membership_id,
          canonical_course_id: args.p_canonical_course_id,
          canonical_lesson_id: args.p_canonical_lesson_id,
          submission_title: args.p_title,
          status: "submitted"
        };
        dbStore.submissions.push(row);
        return { data: { success: true, submission_id: row.id, status: "submitted" } };
      }
      if (func === "grade_agency_homework") {
        const item = dbStore.submissions.find(s => s.id === args.p_submission_id);
        if (!item) return { data: { success: false, code: "submission_not_found" } };
        item.status = args.p_status;
        item.staff_feedback = args.p_feedback;
        item.staff_score = args.p_score;
        return { data: { success: true, submission_id: item.id, status: args.p_status } };
      }
      return { data: null };
    },
    from: (table) => {
      const filters = {};
      const builder = {
        select: () => builder,
        eq: (col, val) => {
          filters[col] = val;
          return builder;
        },
        order: () => {
          const filtered = dbStore.submissions.filter((s) => {
            for (const [k, v] of Object.entries(filters)) {
              if (s[k] !== v) return false;
            }
            return true;
          });
          return { data: filtered, error: null };
        }
      };
      return builder;
    }
  };

  // 1. Submit homework by entitled student -> SUCCESS
  const submission = await submitAgencyHomework(
    { tenant: tenantA, membership: studentMember },
    {
      courseId,
      canonicalLessonId: lessonId,
      title: "Món Phở Hoàn Chỉnh",
      content: { photoUrl: "https://r2.cdn.internal/pho.jpg" }
    },
    { supabaseClient: mockDbClient }
  );

  assert.ok(submission.submissionId);
  assert.equal(submission.status, "submitted");

  // 2. Unentitled student attempt -> REJECTED (403)
  const unentitledMember = {
    id: "m-unentitled",
    agency_id: tenantA.agencyId,
    role: "student",
    status: "active"
  };
  await assert.rejects(
    async () => {
      await submitAgencyHomework(
        { tenant: tenantA, membership: unentitledMember },
        {
          courseId,
          canonicalLessonId: lessonId,
          title: "Unauthorized test"
        },
        { supabaseClient: mockDbClient }
      );
    },
    (err) => err.code === "entitlement_required" && err.status === 403
  );

  // 3. Staff grades submission -> SUCCESS
  const graded = await gradeAgencyHomework(
    { tenant: tenantA, staffMembership: staffMember },
    {
      submissionId: submission.submissionId,
      status: "evaluated",
      score: 9.5,
      feedback: "Nước dùng rất chuẩn vị Hà Nội. Trình bày đẹp mắt!"
    },
    { supabaseClient: mockDbClient }
  );

  assert.equal(graded.status, "evaluated");
  assert.equal(graded.gradedBy, staffMember.id);

  // 4. Student list submissions -> returns only own submission
  const studentList = await listAgencyHomework(
    { tenant: tenantA, membership: studentMember },
    {},
    { supabaseClient: mockDbClient }
  );
  assert.equal(studentList.length, 1);
  assert.equal(studentList[0].id, submission.submissionId);
});

test("B7.4-CROSS-TENANT-HOMEWORK-DENIED: Cross-tenant submission and grading strictly denied", async () => {
  const tenantA = await getTestTenantContext("agency-a.com", "11111111-1111-1111-1111-111111111111");
  const tenantB = await getTestTenantContext("agency-b.com", "22222222-2222-2222-2222-222222222222");

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

  await assert.rejects(
    async () => {
      await submitAgencyHomework(
        { tenant: tenantA, membership: memberAgencyB },
        {
          courseId: "c-1",
          canonicalLessonId: "l-1",
          title: "Spoofing attempt"
        },
        { supabaseClient: {} }
      );
    },
    /Membership does not belong to current tenant/
  );

  await assert.rejects(
    async () => {
      await gradeAgencyHomework(
        { tenant: tenantA, staffMembership: staffAgencyB },
        {
          submissionId: "hw-1",
          status: "evaluated",
          score: 10,
          feedback: "Cross tenant spoof"
        },
        { supabaseClient: {} }
      );
    },
    /Staff membership does not belong to current tenant/
  );
});

test("B7.5-STUDENT-CANNOT-GRADE: Students cannot grade homework submissions", async () => {
  const tenantA = await getTestTenantContext("agency-a.com", "11111111-1111-1111-1111-111111111111");
  const studentMember = {
    id: "m-student",
    agency_id: tenantA.agencyId,
    role: "student",
    status: "active"
  };

  await assert.rejects(
    async () => {
      await gradeAgencyHomework(
        { tenant: tenantA, staffMembership: studentMember },
        {
          submissionId: "hw-1",
          status: "evaluated",
          score: 10,
          feedback: "Student self-grading attempt"
        },
        { supabaseClient: {} }
      );
    },
    (err) => err.code === "forbidden_role" && err.status === 403
  );
});

test("B7.6-INVALID-CANONICAL-LESSON-DENIED: Submission fails closed if canonical lesson is not in course", async () => {
  const tenantA = await getTestTenantContext("agency-a.com", "11111111-1111-1111-1111-111111111111");
  const studentMember = {
    id: "m-stud-1",
    agency_id: tenantA.agencyId,
    role: "student",
    status: "active"
  };

  const mockDbClient = {
    rpc: async () => ({
      data: { success: false, code: "lesson_course_mismatch", error: "Lesson does not belong to specified canonical course" }
    })
  };

  await assert.rejects(
    async () => {
      await submitAgencyHomework(
        { tenant: tenantA, membership: studentMember },
        {
          courseId: "course-1",
          canonicalLessonId: "lesson-from-different-course",
          title: "Mismatch test"
        },
        { supabaseClient: mockDbClient }
      );
    },
    (err) => err.code === "lesson_course_mismatch" && err.status === 400
  );
});
