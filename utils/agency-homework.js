/**
 * utils/agency-homework.js
 *
 * Minimal Tenant Homework MVP Module.
 * Milestone B7:
 * - Tenant/member scoped submission metadata
 * - Lesson / canonical course association
 * - Submission lifecycle (draft -> submitted -> in_review -> evaluated / rejected)
 * - Staff feedback and grading
 * - Scoped isolation: Students see only own work; Staff see tenant work; Cross-tenant strictly denied.
 */

import { assertServerEnvironment } from "./tenant-db-resolver.js";

/**
 * Submits a new homework submission or draft.
 * Requires active student membership and active entitlement to the canonical course.
 */
export async function submitAgencyHomework({
  tenant,
  membership,
  courseId,
  lessonId,
  title,
  content = {},
  dbClient
}) {
  assertServerEnvironment();

  if (!tenant?.agencyId) {
    throw new Error("Missing authoritative tenant context");
  }
  if (!membership?.id || membership.agency_id !== tenant.agencyId) {
    throw new Error("Membership does not belong to current tenant");
  }
  if (!courseId) {
    throw new Error("courseId is required");
  }
  if (!lessonId) {
    throw new Error("lessonId is required");
  }
  if (!title || !title.trim()) {
    throw new Error("title is required");
  }

  // 1. Verify active entitlement
  const { data: entitlement, error: entError } = await dbClient
    .from("student_entitlements")
    .select("id, status, expires_at")
    .eq("agency_id", tenant.agencyId)
    .eq("membership_id", membership.id)
    .eq("canonical_course_id", courseId)
    .eq("status", "active")
    .maybeSingle();

  if (entError || !entitlement) {
    const error = new Error("Active entitlement required to submit homework");
    error.status = 403;
    error.code = "entitlement_required";
    throw error;
  }

  if (entitlement.expires_at && new Date(entitlement.expires_at) < new Date()) {
    const error = new Error("Entitlement has expired");
    error.status = 403;
    error.code = "entitlement_expired";
    throw error;
  }

  // 2. Insert homework submission
  const insertPayload = {
    agency_id: tenant.agencyId,
    membership_id: membership.id,
    canonical_course_id: courseId,
    lesson_id: String(lessonId).trim(),
    submission_title: String(title).trim(),
    submission_content: content,
    status: "submitted",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data: submission, error: insertError } = await dbClient
    .from("agency_homework_submissions")
    .insert(insertPayload)
    .select()
    .single();

  if (insertError) {
    throw new Error(`Failed to create homework submission: ${insertError.message}`);
  }

  return submission;
}

/**
 * Grades a homework submission.
 * Requires agency_staff or agency_owner role within the same tenant.
 */
export async function gradeAgencyHomework({
  tenant,
  staffMembership,
  submissionId,
  status = "evaluated",
  feedback,
  score,
  dbClient
}) {
  assertServerEnvironment();

  if (!tenant?.agencyId) {
    throw new Error("Missing authoritative tenant context");
  }
  if (!staffMembership?.id || staffMembership.agency_id !== tenant.agencyId) {
    throw new Error("Staff membership does not belong to current tenant");
  }
  if (!["agency_staff", "agency_owner"].includes(staffMembership.role)) {
    const error = new Error("Only agency staff or owners can grade homework");
    error.status = 403;
    error.code = "forbidden_role";
    throw error;
  }
  if (!submissionId) {
    throw new Error("submissionId is required");
  }

  const validStatuses = ["in_review", "evaluated", "rejected"];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid grading status '${status}'. Must be one of: ${validStatuses.join(", ")}`);
  }

  const updatePayload = {
    status,
    staff_feedback: feedback !== undefined ? String(feedback).trim() : null,
    staff_score: score !== undefined ? Number(score) : null,
    reviewed_by_membership_id: staffMembership.id,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data: updated, error: updateError } = await dbClient
    .from("agency_homework_submissions")
    .update(updatePayload)
    .eq("id", submissionId)
    .eq("agency_id", tenant.agencyId)
    .select()
    .single();

  if (updateError || !updated) {
    const error = new Error("Homework submission not found in current agency");
    error.status = 404;
    error.code = "submission_not_found";
    throw error;
  }

  return updated;
}

/**
 * Lists homework submissions for a course/lesson.
 * Scoped boundary:
 * - Students see only their own submissions.
 * - Staff/owners see all submissions within current agency.
 */
export async function listAgencyHomework({
  tenant,
  membership,
  courseId,
  status,
  dbClient
}) {
  assertServerEnvironment();

  if (!tenant?.agencyId) {
    throw new Error("Missing authoritative tenant context");
  }
  if (!membership?.id || membership.agency_id !== tenant.agencyId) {
    throw new Error("Membership does not belong to current tenant");
  }

  let query = dbClient
    .from("agency_homework_submissions")
    .select("*")
    .eq("agency_id", tenant.agencyId);

  // If student, strictly filter by membership_id
  const isStaff = ["agency_staff", "agency_owner"].includes(membership.role);
  if (!isStaff) {
    query = query.eq("membership_id", membership.id);
  }

  if (courseId) {
    query = query.eq("canonical_course_id", courseId);
  }
  if (status) {
    query = query.eq("status", status);
  }

  query = query.order("created_at", { ascending: false });

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list homework submissions: ${error.message}`);
  }

  return data || [];
}
