/**
 * utils/agency-homework.js
 *
 * Minimal Tenant Homework MVP Module.
 * Milestone B7 / Pre-M0C Remediation V2 Hardened:
 * - Server-only write path strictly bound to request auth chain (req -> auth.uid() -> current agency -> active membership)
 * - Untrusted caller-provided membership objects are STRICTLY REJECTED (Finding 7B)
 * - Canonical lesson foreign key validation and course matching
 * - Student submission requires active course entitlement
 * - Staff grading requires staff/owner role within the verified agency
 * - Scoped isolation: Students see only own work; Staff see tenant work; Cross-tenant strictly denied.
 */

import { assertServerEnvironment } from "./tenant-db-resolver.js";
import { requireAgencyMembership, requireAgencyRole } from "./agency-auth.js";
import { supabase as defaultSupabase } from "./supabase.js";

/**
 * Asserts request input and resolves verified membership and tenant via auth chain.
 * Rejects unverified caller-supplied objects.
 */
function assertRequestInput(req) {
  if (!req || (!req.headers && typeof req.getHeader !== "function")) {
    const err = new Error("SECURITY VIOLATION: Operation requires a valid HTTP Request with verified authentication headers. Caller-provided membership objects are prohibited.");
    err.status = 401;
    err.code = "request_auth_required";
    throw err;
  }
}

/**
 * Submits a new homework submission.
 * Derives caller identity strictly from: request -> auth user -> current agency -> active membership.
 * Requires active student membership and active entitlement to the canonical course.
 * B7.2: Canonical lesson must be validated against canonical_course_id in canonical_lessons.
 */
export async function submitAgencyHomework(req, payload = {}, options = {}) {
  assertServerEnvironment();
  assertRequestInput(req);

  // Authenticate caller through trusted auth chain
  const authResult = await requireAgencyMembership(req, options);
  if (!authResult.ok) {
    return authResult;
  }

  const { tenant, membership } = authResult;
  const client = options.supabaseClient || defaultSupabase;

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

  // Call hardened RPC with canonical lesson FK validation and entitlement verification
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
 * Derives staff identity strictly from request -> verified role (agency_staff or agency_owner) in tenant.
 */
export async function gradeAgencyHomework(req, payload = {}, options = {}) {
  assertServerEnvironment();
  assertRequestInput(req);

  const roleResult = await requireAgencyRole(req, ["agency_staff", "agency_owner"], options);
  if (!roleResult.ok) {
    return roleResult;
  }

  const { tenant, membership: staffMembership } = roleResult;
  const client = options.supabaseClient || defaultSupabase;

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
export async function listAgencyHomework(req, filters = {}, options = {}) {
  assertServerEnvironment();
  assertRequestInput(req);

  const authResult = await requireAgencyMembership(req, options);
  if (!authResult.ok) {
    return authResult;
  }

  const { tenant, membership } = authResult;
  const client = options.supabaseClient || defaultSupabase;

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
