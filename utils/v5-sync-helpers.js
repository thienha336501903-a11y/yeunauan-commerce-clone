const normalizeBase = value => String(value || '').trim().replace(/\/$/, '');

function baseResult(lmsUrl) {
  return { lms: lmsUrl ? 'SKIPPED' : 'DISABLED', portal: 'SKIPPED_V5', error: null };
}

async function callV5(payload) {
  const secret = String(process.env.INTERNAL_SYNC_SECRET || '').trim();
  const lmsUrl = normalizeBase(process.env.SYSTEM3_URL || process.env.LMS_PUBLIC_URL);
  const result = baseResult(lmsUrl);
  if (!lmsUrl) return result;
  if (!secret) return { ...result, lms: 'FAILED', error: 'Missing INTERNAL_SYNC_SECRET' };
  try {
    const response = await fetch(`${lmsUrl}/api/v5-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': secret },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ...result, lms: 'FAILED', error: `LMS V5 failed: ${data.error || response.statusText}` };
    return { lms: 'SUCCESS', portal: 'SKIPPED_V5', error: null, data };
  } catch (error) {
    return { ...result, lms: 'FAILED', error: `LMS V5 error: ${error.message || error}` };
  }
}

export async function syncV5CourseToLms(courseData) {
  return callV5({
    action: 'syncCourse',
    slug: String(courseData.slug || '').trim(),
    title: String(courseData.courseName || courseData.title || '').trim(),
    subtitle: String(courseData.subtitle || '').trim(),
    imageUrl: String(courseData.imageUrl || courseData.image_url || '').trim(),
    expected_start_date: courseData.expected_start_date || null,
    active: courseData.active !== false,
    deliveryMode: 'v5'
  });
}

export async function syncV5EnrollmentToLms(orderData, actionType) {
  const email = String(orderData.customer_email || orderData.gmail || '').trim().toLowerCase();
  const courseSlug = String(orderData.course_slug || orderData.course || '').trim();
  if (!email || !courseSlug) return { lms: 'FAILED', portal: 'SKIPPED_V5', error: 'Missing email or course slug' };
  return callV5({
    action: actionType === 'create' ? 'syncEnrollment' : 'revokeEnrollment',
    email,
    courseSlug,
    orderId: String(orderData.id || orderData.source_order_id || '').trim() || null,
    deliveryMode: 'v5'
  });
}
