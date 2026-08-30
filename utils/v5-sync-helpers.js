import { cloneConfig } from './clone-config.js';

const normalizeBase = value => String(value || '').trim().replace(/\/$/, '');
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

function baseResult(lmsUrl) {
  return {
    lms: lmsUrl ? 'SKIPPED' : 'DISABLED',
    portal: 'SKIPPED_V5',
    error: null
  };
}

function productionV5Base() {
  const explicit = String(process.env.V5_LMS_PUBLIC_URL || '').trim();
  if (explicit) return explicit;
  return cloneConfig().v4PublicUrl;
}

async function callV5(payload) {
  const secret = String(process.env.V5_SYNC_SECRET || '').trim();
  const previewOverride = process.env.VERCEL_ENV === 'preview' ? process.env.V5_LMS_SYNC_URL : '';
  const previewBypass = process.env.VERCEL_ENV === 'preview' ? String(process.env.V5_LMS_PROTECTION_BYPASS || '').trim() : '';
  const lmsUrl = normalizeBase(previewOverride || productionV5Base());
  const result = baseResult(lmsUrl);

  if (!lmsUrl) return result;
  if (!secret) {
    result.lms = 'FAILED';
    result.error = 'Missing V5_SYNC_SECRET';
    return result;
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      'X-Sync-Secret': secret
    };
    if (previewBypass) headers['x-vercel-protection-bypass'] = previewBypass;
    const response = await fetch(`${lmsUrl}/api/v5-sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      result.lms = 'SUCCESS';
      return result;
    }
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text().catch(() => '');
    result.lms = 'FAILED';
    result.error = `V5 LMS failed ${response.status} ${contentType}: ${text.slice(0, 180)}`;
    return result;
  } catch (error) {
    result.lms = 'FAILED';
    result.error = `V5 LMS error: ${error.message || error}`;
    return result;
  }
}

export async function syncV5CourseToLms(courseData) {
  const payload = {
    action: 'syncCourse',
    slug: String(courseData.slug || '').trim(),
    title: String(courseData.courseName || courseData.title || '').trim(),
    subtitle: String(courseData.subtitle || courseData.description || '').trim(),
    imageUrl: String(courseData.imageUrl || courseData.image_url || '').trim()
  };

  // Omitted fields mean "preserve current LMS state". A metadata-only sync must
  // never silently turn V5 sales off or clear a start date.
  if (hasOwn(courseData, 'active')) payload.active = courseData.active === true;
  if (hasOwn(courseData, 'expected_start_date')) payload.expected_start_date = courseData.expected_start_date || null;

  return callV5(payload);
}

export async function syncV5EnrollmentToLms(orderData, actionType) {
  const email = String(orderData.customer_email || orderData.gmail || '').trim().toLowerCase();
  const courseSlug = String(orderData.course_slug || orderData.course || '').trim();
  const actionMap = {
    create: 'syncEnrollment',
    restore: 'restoreEnrollment',
    revoke: 'revokeEnrollment'
  };
  const action = actionMap[String(actionType || '').trim().toLowerCase()];
  if (!action) {
    return { lms: 'FAILED', portal: 'SKIPPED_V5', error: 'Invalid V5 enrollment sync action' };
  }
  if (!email || !courseSlug) {
    return { lms: 'FAILED', portal: 'SKIPPED_V5', error: 'Missing email or course slug' };
  }
  return callV5({
    action,
    email,
    courseSlug,
    orderId: String(orderData.id || orderData.source_order_id || '').trim() || null
  });
}
