const normalizeBase = value => String(value || '').trim().replace(/\/$/, '');

function baseResult(lmsUrl) {
  return {
    lms: lmsUrl ? 'SKIPPED' : 'DISABLED',
    portal: 'SKIPPED_V5',
    error: null
  };
}

async function callV5(payload) {
  const secret = String(process.env.INTERNAL_SYNC_SECRET || '').trim();
  const previewOverride = process.env.VERCEL_ENV === 'preview' ? process.env.V5_LMS_SYNC_URL : '';
  const lmsUrl = normalizeBase(previewOverride || process.env.LMS_PUBLIC_URL || process.env.SYSTEM3_URL);
  const result = baseResult(lmsUrl);

  if (!lmsUrl) return result;
  if (!secret) {
    result.lms = 'FAILED';
    result.error = 'Missing INTERNAL_SYNC_SECRET';
    return result;
  }

  try {
    const response = await fetch(`${lmsUrl}/api/v5-sync`, {
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
    result.error = `V5 LMS failed: ${data.error || response.statusText}`;
    return result;
  } catch (error) {
    result.lms = 'FAILED';
    result.error = `V5 LMS error: ${error.message || error}`;
    return result;
  }
}

export async function syncV5CourseToLms(courseData) {
  return callV5({
    action: 'syncCourse',
    slug: String(courseData.slug || '').trim(),
    title: String(courseData.courseName || courseData.title || '').trim(),
    subtitle: String(courseData.subtitle || courseData.description || '').trim(),
    imageUrl: String(courseData.imageUrl || courseData.image_url || '').trim(),
    expected_start_date: courseData.expected_start_date || null,
    active: courseData.active !== undefined ? courseData.active : true
  });
}

export async function syncV5EnrollmentToLms(orderData, actionType) {
  const email = String(orderData.customer_email || orderData.gmail || '').trim().toLowerCase();
  const courseSlug = String(orderData.course_slug || orderData.course || '').trim();
  if (!email || !courseSlug) {
    return { lms: 'FAILED', portal: 'SKIPPED_V5', error: 'Missing email or course slug' };
  }
  return callV5({
    action: actionType === 'create' ? 'syncEnrollment' : 'revokeEnrollment',
    email,
    courseSlug,
    orderId: String(orderData.id || orderData.source_order_id || '').trim() || null
  });
}
