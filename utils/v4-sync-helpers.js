const normalizeBase = value => String(value || '').trim().replace(/\/$/, '');

function baseResult(lmsUrl) {
  return {
    lms: lmsUrl ? 'SKIPPED' : 'DISABLED',
    portal: 'SKIPPED_V4',
    error: null
  };
}

async function callLms(payload) {
  const secret = String(process.env.INTERNAL_SYNC_SECRET || '').trim();
  const lmsUrl = normalizeBase(process.env.SYSTEM3_URL || process.env.LMS_PUBLIC_URL);
  const result = baseResult(lmsUrl);

  if (!lmsUrl) return result;
  if (!secret) {
    result.lms = 'FAILED';
    result.error = 'Missing INTERNAL_SYNC_SECRET';
    return result;
  }

  try {
    const response = await fetch(`${lmsUrl}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Secret': secret
      },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      result.lms = 'SUCCESS';
      return result;
    }
    const data = await response.json().catch(() => ({}));
    result.lms = 'FAILED';
    result.error = `LMS failed: ${data.error || response.statusText}`;
    return result;
  } catch (error) {
    result.lms = 'FAILED';
    result.error = `LMS error: ${error.message || error}`;
    return result;
  }
}

export async function syncV4CourseToLms(courseData) {
  return callLms({
    action: 'syncCourse',
    deliveryMode: 'v4',
    slug: String(courseData.slug || '').trim(),
    title: String(courseData.courseName || courseData.title || '').trim(),
    subtitle: String(courseData.subtitle || '').trim(),
    imageUrl: String(courseData.imageUrl || courseData.image_url || '').trim(),
    expected_start_date: courseData.expected_start_date || null,
    active: courseData.active !== undefined ? courseData.active : true
  });
}

export async function syncV4EnrollmentToLms(orderData, actionType) {
  const email = String(orderData.customer_email || orderData.gmail || '').trim().toLowerCase();
  const courseSlug = String(orderData.course_slug || orderData.course || '').trim();
  if (!email || !courseSlug) {
    return { lms: 'FAILED', portal: 'SKIPPED_V4', error: 'Missing email or course slug' };
  }
  return callLms({
    action: actionType === 'create' ? 'syncEnrollment' : 'revokeEnrollment',
    email,
    courseSlug,
    orderId: String(orderData.id || orderData.source_order_id || '').trim() || null,
    deliveryMode: 'v4'
  });
}
