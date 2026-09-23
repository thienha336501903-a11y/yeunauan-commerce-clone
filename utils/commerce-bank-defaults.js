/**
 * Utility functions for default bank payment information inheritance in Commerce.
 * Used when creating new courses to pre-fill bank transfer details from the most
 * recently created course that has valid, reusable payment details.
 */

/**
 * Checks if a course has valid, reusable bank payment details.
 * A course is eligible if:
 * 1. It is a valid non-null object.
 * 2. It has a non-empty bankAccount string (trimmed).
 * 3. It has at least one of bankName, bankOwner, or qrImageUrl (non-empty trimmed).
 *
 * @param {Object} course
 * @returns {boolean}
 */
export function hasReusablePaymentInfo(course) {
  if (!course || typeof course !== 'object') return false;
  const bankAccount = String(course.bankAccount || '').trim();
  if (!bankAccount) return false;
  const bankName = String(course.bankName || '').trim();
  const bankOwner = String(course.bankOwner || '').trim();
  const qrImageUrl = String(course.qrImageUrl || '').trim();
  return Boolean(bankName || bankOwner || qrImageUrl);
}

/**
 * Safely parses a course's created_at timestamp into epoch milliseconds.
 * Returns 0 if missing, null, or invalid Date.
 *
 * @param {Object} course
 * @returns {number}
 */
export function parseCourseDate(course) {
  if (!course || !course.created_at) return 0;
  const t = new Date(course.created_at).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Finds the latest course with valid reusable payment information.
 * Sorts courses by created_at descending (newest first).
 * Ties are broken deterministically by course id descending.
 * Returns the first course matching hasReusablePaymentInfo, or null if none found.
 *
 * @param {Array<Object>} courses
 * @returns {Object|null}
 */
export function latestReusablePaymentCourse(courses) {
  if (!Array.isArray(courses) || courses.length === 0) return null;
  const sorted = [...courses].sort((a, b) => {
    const diff = parseCourseDate(b) - parseCourseDate(a);
    if (diff !== 0) return diff;
    const idA = String((a && a.id) || '');
    const idB = String((b && b.id) || '');
    return idB.localeCompare(idA);
  });
  return sorted.find(hasReusablePaymentInfo) || null;
}
