/**
 * utils/agency-homework.js
 *
 * Minimal Tenant Homework MVP Module.
 * Milestone B7 / M0B.1 Hardened:
 * - Tenant/member scoped submission metadata
 * - Lesson / canonical course association with canonical_lesson_id foreign key validation
 * - Submission lifecycle (draft -> submitted -> in_review -> evaluated / rejected)
 * - Staff feedback and grading
 * - Scoped isolation: Students see only own work; Staff see tenant work; Cross-tenant strictly denied.
 */

import { assertServerEnvironment, assertTrustedTenantInput } from "./tenant-db-resolver.js";
import { requireAgencyMembership, requireAgencyRole } from "./agency-auth.js";
import { supabase as defaultSupabase } from "./supabase.js";

/**
 * Submits a new homework submission.
 * Requires active student membership and active entitlement to the canonical course.
 * B7.2: Canonical lesson must be validated against canonical_course_id in canonical_lessons.
 */
export async function submitAgencyHomework(reqOrContext, payload = {}, options = {}) {
  assertServerEnvironment();

  let tenant, membership, client;

  // If passed an HTTP request, authenticate caller
  if (reqOrContext.headers || typeof reqOrContext.getHeader === "function") {
    const authResult = await requireAgencyMembership(reqOrContext, options);
    if (!authResult.ok) {
      return authResult;
    }
    tenant = authResult.tenant;
    membership = authResult.membership;
    client = options.supabaseClient || defaultSupabase;
  } else {
    // If called with explicit context object
    tenant = await assertTrustedTenantInput(reqOrContext.tenant || reqOrContext, options);
    membership = reqOrContext.membership;
    client = options.supabaseClient || defaultSupabase;
  }

  if (!membership?.id || membership.agency_id !== tenant.agencyId) {
    const err = new Error("Membership does not belong to current tenant");
    err.status = 403;
    err.code = "forbidden_membership";
    throw err;
  }

  const courseId = payload.courseId || payload.canonicalCourseId;
  const canonicalLessonId = payload.canonicalLessonId || payload.lessonId;
  const title = payload.title || payload.submissionTitle;
  const content = payload.content || payload.submissionContent || {};

  if (!courseId) {
    const err = new Error("courseId is required");
    err.status = 400;
    err.code = "missing_course_id";
    throw err;
  }
  if (!canonicalLessonId) {
    const err = new Error("canonicalLessonId is required");
    err.status = 400;
    err.code = "missing_lesson_id";
    throw err;
  }
  if (!title || !title.trim()) {
    const err = new Error("title is required");
    err.status = 400;
    err.code = "missing_title";
    throw err;
  }

  // Call hardened RPC with canonical lesson FK validation
  const { data, error } = await client.rpc("submit_agency_homework", {
    p_agency_id: tenant.agencyId,
    p_membership_id: membership.id,
    p_canonical_course_id: courseId,
    p_canonical_lesson_id: canonicalLessonId,
    p_title: title.trim(),
    p_content: content
  });

  if (error) {
    console.error("[agency-homework] submit error:", error);
    const err = new Error(error.message);
    err.status = 500;
    err.code = "submit_error";
    throw err;
  }

  if (!data.success) {
    const err = new Error(data.error || "Failed to submit homework");
    err.status = data.code === "entitlement_required" ? 403 : 400;
    err.code = data.code;
    throw err;
  }

  return {
    ok: true,
    submissionId: data.submission_id,
    status: data.status,
    agencyId: tenant.agencyId,
    membershipId: membership.id,
    canonicalCourseId: courseId,
    canonicalLessonId
  };
}

/**
 * Grades a homework submission.
 * Requires agency_staff or agency_owner role within the same tenant.
 */
export async function gradeAgencyHomework(reqOrContext, payload = {}, options = {}) {
  assertServerEnvironment();

  let tenant, staffMembership, client;

  if (reqOrContext.headers || typeof reqOrContext.getHeader === "function") {
    const roleResult = await requireAgencyRole(reqOrContext, ["agency_staff", "agency_owner"], options);
    if (!roleResult.ok) {
      return roleResult;
    }
    tenant = roleResult.tenant;
    staffMembership = roleResult.membership;
    client = options.supabaseClient || defaultSupabase;
  } else {
    tenant = await assertTrustedTenantInput(reqOrContext.tenant || reqOrContext, options);
    staffMembership = reqOrContext.staffMembership;
    client = options.supabaseClient || defaultSupabase;
  }

  if (!staffMembership?.id || staffMembership.agency_id !== tenant.agencyId) {
    const err = new Error("Staff membership does not belong to current tenant");
    err.status = 403;
    err.code = "forbidden_membership";
    throw err;
  }
  if (!["agency_staff", "agency_owner"].includes(staffMembership.role)) {
    const err = new Error("Only agency staff or owners can grade homework");
    err.status = 403;
    err.code = "forbidden_role";
    throw err;
  }

  const { submissionId, status = "evaluated", feedback, score } = payload;
  if (!submissionId) {
    const err = new Error("submissionId is required");
    err.status = 400;
    err.code = "missing_submission_id";
    throw err;
  }

  const validStatuses = ["in_review", "evaluated", "rejected"];
  if (!validStatuses.includes(status)) {
    const err = new Error(`Invalid grading status '${status}'. Must be one of: ${validStatuses.join(", ")}`);
    err.status = 400;
    err.code = "invalid_status";
    throw err;
  }

  const { data, error } = await client.rpc("grade_agency_homework", {
    p_agency_id: tenant.agencyId,
    p_staff_membership_id: staffMembership.id,
    p_submission_id: submissionId,
    p_status: status,
    p_feedback: feedback !== undefined ? String(feedback).trim() : null,
    p_score: score !== undefined ? Number(score) : null
  });

  if (error) {
    console.error("[agency-homework] grade error:", error);
    const err = new Error(error.message);
    err.status = 500;
    err.code = "grade_error";
    throw err;
  }

  if (!data.success) {
    const err = new Error(data.error || "Failed to grade homework");
    err.status = data.code === "submission_not_found" ? 404 : 403;
    err.code = data.code;
    throw err;
  }

  return {
    ok: true,
    submissionId: data.submission_id,
    status: data.status,
    gradedBy: staffMembership.id
  };
}

/**
 * Lists homework submissions for a course/lesson.
 * Scoped boundary:
 * - Students see only their own submissions.
 * - Staff/owners see all submissions within current agency.
 */
export async function listAgencyHomework(reqOrContext, filters = {}, options = {}) {
  assertServerEnvironment();

  let tenant, membership, client;

  if (reqOrContext.headers || typeof reqOrContext.getHeader === "function") {
    const authResult = await requireAgencyMembership(reqOrContext, options);
    if (!authResult.ok) {
      return authResult;
    }
    tenant = authResult.tenant;
    membership = authResult.membership;
    client = options.supabaseClient || defaultSupabase;
  } else {
    tenant = await assertTrustedTenantInput(reqOrContext.tenant || reqOrContext, options);
    membership = reqOrContext.membership;
    client = options.supabaseClient || defaultSupabase;
  }

  if (!membership?.id || membership.agency_id !== tenant.agencyId) {
    throw new Error("Membership does not belong to current tenant");
  }

  let query = client
    .from("agency_homework_submissions")
    .select("id, agency_id, membership_id, canonical_course_id, canonical_lesson_id, submission_title, submission_content, status, staff_feedback, staff_score, reviewed_at, created_at, updated_at")
    .eq("agency_id", tenant.agencyId);

  // If student, strictly filter by membership_id
  const isStaff = ["agency_staff", "agency_owner"].includes(membership.role);
  if (!isStaff) {
    query = query.eq("membership_id", membership.id);
  }

  if (filters.courseId) {
    query = query.eq("canonical_course_id", filters.courseId);
  }
  if (filters.canonicalLessonId) {
    query = query.eq("canonical_lesson_id", filters.canonicalLessonId);
  }
  if (filters.status) {
    query = query.eq("status", filters.status);
  }

  query = query.order("created_at", { ascending: false });

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list homework submissions: ${error.message}`);
  }

  return data || [];
}
