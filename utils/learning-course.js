const SLUG_PATTERN = /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/i;

export const GRANTING_ORDER_STATUSES = Object.freeze(["Đã duyệt"]);

export function normalizeLearningSlug(value) {
  return String(value || "").trim();
}

export function getEffectiveLearningSlug(courseOrOrder) {
  return normalizeLearningSlug(
    courseOrOrder?.learning_course_slug ||
    courseOrOrder?.course_slug ||
    courseOrOrder?.slug ||
    courseOrOrder?.course
  );
}

export function snapshotOrderLearningSlug(course) {
  return getEffectiveLearningSlug(course);
}

export function isGrantingOrderStatus(status) {
  return GRANTING_ORDER_STATUSES.includes(String(status || "").trim());
}

export function normalizeCustomerEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function validateLearningCourseTarget(salesCourse, targetCourse, lessonCount) {
  const salesSlug = normalizeLearningSlug(salesCourse?.slug);
  const targetSlug = normalizeLearningSlug(targetCourse?.slug);
  if (!salesSlug || !targetSlug || !SLUG_PATTERN.test(targetSlug)) {
    throw new Error("Slug khóa học LMS đích không hợp lệ");
  }
  if (salesSlug === targetSlug) return targetCourse;
  if (!targetCourse?.active) throw new Error("Khóa học LMS đích không hoạt động");
  const nestedTarget = normalizeLearningSlug(targetCourse.learning_course_slug);
  if (nestedTarget && nestedTarget !== targetSlug) {
    throw new Error("Không hỗ trợ chuỗi alias nhiều tầng");
  }
  if (nestedTarget === salesSlug) throw new Error("Mapping khóa học LMS bị vòng lặp");
  if (Number(lessonCount || 0) < 1) throw new Error("Khóa học LMS đích chưa có bài học");
  return targetCourse;
}

export async function resolveLearningCourse(salesCourse, { findCourseBySlug, countLessons }) {
  const salesSlug = normalizeLearningSlug(salesCourse?.slug);
  const learningSlug = getEffectiveLearningSlug(salesCourse);
  if (!salesSlug || !learningSlug) throw new Error("Thiếu slug khóa học");
  if (!SLUG_PATTERN.test(learningSlug)) throw new Error("Slug khóa học LMS đích không hợp lệ");
  if (learningSlug === salesSlug) {
    return { salesCourse, learningCourse: salesCourse, learningSlug, lessonCount: null, mapped: false };
  }
  const target = await findCourseBySlug(learningSlug);
  if (!target) throw new Error("Không tìm thấy khóa học LMS đích");
  const lessonCount = await countLessons(learningSlug);
  validateLearningCourseTarget(salesCourse, target, lessonCount);
  return { salesCourse, learningCourse: target, learningSlug, lessonCount, mapped: true };
}

export async function resolveLearningCourseFromSupabase(salesCourse, client) {
  return resolveLearningCourse(salesCourse, {
    async findCourseBySlug(slug) {
      const { data, error } = await client
        .from("courses")
        .select("id,slug,title,active,learning_course_slug")
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async countLessons(slug) {
      const { count, error } = await client
        .from("lessons")
        .select("id", { count: "exact", head: true })
        .eq("course_slug", slug)
        .neq("status", "hidden");
      if (error) throw error;
      return count || 0;
    }
  });
}

export async function hasAnotherGrantingOrder(client, order) {
  const email = normalizeCustomerEmail(order?.customer_email || order?.gmail);
  const learningSlug = getEffectiveLearningSlug(order);
  if (!email || !learningSlug) return false;
  const { data, error } = await client
    .from("orders")
    .select("id,customer_email,course_slug,learning_course_slug,status")
    .ilike("customer_email", email);
  if (error) throw error;
  return (data || []).some((candidate) =>
    candidate.id !== order.id &&
    normalizeCustomerEmail(candidate.customer_email) === email &&
    getEffectiveLearningSlug(candidate) === learningSlug &&
    isGrantingOrderStatus(candidate.status)
  );
}
