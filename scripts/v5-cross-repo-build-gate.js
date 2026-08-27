import crypto from 'node:crypto';
import { supabase } from '../utils/supabase.js';
import { syncV5CourseToLms } from '../utils/v5-sync-helpers.js';
import approveAllHandler from '../api/approve-all.js';
import ordersHandler from '../api/orders.js';

// Preview rerun marker after V5_LMS_PROTECTION_BYPASS correction.
const LMS_PREVIEW = 'https://yeunauan-lms-clone-bpyhy6quf.vercel.app';
const PREFIX = '__clone_factory_test_v5_build_gate_';
const DIAG_PREFIX = '__clone_factory_test_v5_build_diag_';

function mockResponse() {
  const state = { statusCode: 200, body: null, headers: {} };
  return {
    state,
    setHeader(name, value) { state.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { state.statusCode = code; return this; },
    json(body) { state.body = body; return this; },
    end() { return this; }
  };
}

async function invoke(handler, req) {
  const res = mockResponse();
  await handler(req, res);
  return res.state;
}

function assertGate(name, condition, detail = null) {
  if (!condition) throw new Error(`V5_BUILD_GATE_FAILED:${name}${detail ? ':' + detail : ''}`);
  console.log(`[V5_BUILD_GATE] PASS ${name}`);
}

function safeDiag(error) {
  return String(error?.message || error || 'unknown').replace(/[\r\n]+/g, ' ').slice(0, 700);
}

async function main() {
  const suffix = crypto.randomBytes(6).toString('hex');
  const slug = `clone-factory-test-v5-build-${suffix}`;
  const title = `${PREFIX}${suffix}`;
  const email = `${PREFIX}${suffix}@example.com`;
  const orderId = crypto.randomUUID();
  const previousTarget = process.env.V5_LMS_SYNC_URL;
  const markerId = crypto.randomUUID();
  const markerSlug = `clone-factory-test-v5-build-diag-${suffix}`;
  let currentStep = 'marker_insert';
  let allPassed = false;

  const { error: markerError } = await supabase.from('courses').insert({
    id: markerId,
    slug: markerSlug,
    title: `${DIAG_PREFIX}${suffix}`,
    subtitle: 'RUNNING',
    delivery_mode: 'v5',
    active: false,
    is_published: false,
    sort_order: 999,
    updated_at: new Date().toISOString()
  });
  if (markerError) throw markerError;

  try {
    currentStep = 'preview_environment';
    assertGate(currentStep, process.env.VERCEL_ENV === 'preview', String(process.env.VERCEL_ENV || 'missing'));
    const bypass = String(process.env.V5_LMS_PROTECTION_BYPASS || '').trim();
    currentStep = 'protection_bypass_present';
    assertGate(currentStep, Boolean(bypass));
    currentStep = 'protection_bypass_length';
    assertGate(currentStep, bypass.length === 32, `length=${bypass.length}`);
    currentStep = 'internal_sync_secret_present';
    assertGate(currentStep, Boolean(String(process.env.INTERNAL_SYNC_SECRET || '').trim()));
    currentStep = 'admin_password_present';
    assertGate(currentStep, Boolean(String(process.env.ADMIN_PASSWORD || '').trim()));

    process.env.V5_LMS_SYNC_URL = LMS_PREVIEW;

    currentStep = 'sync_course';
    const courseSync = await syncV5CourseToLms({ slug, courseName: title, description: 'Temporary cross-repo build gate', active: true });
    assertGate(currentStep, courseSync.lms === 'SUCCESS' && courseSync.portal === 'SKIPPED_V5', JSON.stringify(courseSync));

    currentStep = 'course_v5';
    const { data: course, error: courseError } = await supabase.from('courses').select('id,slug,delivery_mode').eq('slug', slug).single();
    if (courseError) throw courseError;
    assertGate(currentStep, String(course.delivery_mode).toLowerCase() === 'v5');

    currentStep = 'publish_fixture';
    const now = new Date().toISOString();
    const { error: publishError } = await supabase.from('courses').update({ active: true, is_published: true, updated_at: now }).eq('id', course.id);
    if (publishError) throw publishError;
    const { error: configError } = await supabase.from('v5_course_configs').upsert({ course_id: course.id, source_mode: 'direct', status: 'published', updated_at: now }, { onConflict: 'course_id' });
    if (configError) throw configError;

    currentStep = 'insert_order';
    const { error: orderError } = await supabase.from('orders').insert({
      id: orderId,
      course_id: course.id,
      course_slug: slug,
      course_title: title,
      customer_email: email,
      proof_image_url: 'https://example.com/test-only.png',
      status: 'Chờ duyệt',
      delivery_mode: 'v5',
      raw_data: { billName: `${PREFIX}${suffix}.png`, buildGate: true }
    });
    if (orderError) throw orderError;

    currentStep = 'approve';
    const approved = await invoke(approveAllHandler, {
      method: 'POST',
      headers: { 'x-admin-password': process.env.ADMIN_PASSWORD },
      body: { course: slug }
    });
    assertGate('approve_http_200', approved.statusCode === 200, JSON.stringify(approved.body));
    assertGate('approve_sync_success', approved.body?.count === 1 && approved.body?.syncSucceeded === 1 && approved.body?.syncFailed === 0, JSON.stringify(approved.body));

    currentStep = 'order_after_approve';
    const { data: orderAfterApprove, error: orderReadError } = await supabase.from('orders').select('status,sync_lms_status,sync_portal_status,sync_error').eq('id', orderId).single();
    if (orderReadError) throw orderReadError;
    assertGate('order_approved', orderAfterApprove.status === 'Đã duyệt', JSON.stringify(orderAfterApprove));
    assertGate('order_sync_status', orderAfterApprove.sync_lms_status === 'SUCCESS' && orderAfterApprove.sync_portal_status === 'SKIPPED_V5' && !orderAfterApprove.sync_error, JSON.stringify(orderAfterApprove));

    currentStep = 'enrollment_after_approve';
    let { data: enrollment, error: enrollmentError } = await supabase.from('student_enrollments').select('status,source_system,source_order_id').eq('email', email).eq('course_slug', slug).single();
    if (enrollmentError) throw enrollmentError;
    assertGate('enrollment_active', enrollment.status === 'active', JSON.stringify(enrollment));
    assertGate('order_correlation', enrollment.source_system === 'commerce_v5' && enrollment.source_order_id === orderId, JSON.stringify(enrollment));

    const headers = { 'x-admin-password': process.env.ADMIN_PASSWORD };
    currentStep = 'resync_approved';
    const resyncApproved = await invoke(ordersHandler, { method: 'PUT', headers, body: { id: orderId, action: 'resync' } });
    assertGate('resync_approved_http_200', resyncApproved.statusCode === 200, JSON.stringify(resyncApproved.body));
    assertGate('resync_approved_success', resyncApproved.body?.data?.syncResults?.lms === 'SUCCESS' && resyncApproved.body?.data?.syncResults?.portal === 'SKIPPED_V5', JSON.stringify(resyncApproved.body));

    currentStep = 'revoke';
    const revoke = await invoke(ordersHandler, { method: 'PUT', headers, body: { id: orderId, status: 'Từ chối', note: 'temporary V5 build gate revoke' } });
    assertGate('revoke_http_200', revoke.statusCode === 200, JSON.stringify(revoke.body));
    assertGate('revoke_sync_success', revoke.body?.data?.syncResults?.lms === 'SUCCESS' && revoke.body?.data?.syncResults?.portal === 'SKIPPED_V5', JSON.stringify(revoke.body));

    currentStep = 'enrollment_after_revoke';
    ({ data: enrollment, error: enrollmentError } = await supabase.from('student_enrollments').select('status,source_system,source_order_id').eq('email', email).eq('course_slug', slug).single());
    if (enrollmentError) throw enrollmentError;
    assertGate('enrollment_revoked', enrollment.status === 'revoked', JSON.stringify(enrollment));

    currentStep = 'resync_revoked';
    const resyncRevoked = await invoke(ordersHandler, { method: 'PUT', headers, body: { id: orderId, action: 'resync' } });
    assertGate('resync_revoked_http_200', resyncRevoked.statusCode === 200, JSON.stringify(resyncRevoked.body));
    assertGate('resync_revoked_idempotent', resyncRevoked.body?.data?.syncResults?.lms === 'SUCCESS', JSON.stringify(resyncRevoked.body));

    allPassed = true;
    console.log('[V5_BUILD_GATE] ALL_PASS');
  } catch (error) {
    await supabase.from('courses').update({
      subtitle: `FAIL|${currentStep}|${safeDiag(error)}`,
      updated_at: new Date().toISOString()
    }).eq('id', markerId);
    throw error;
  } finally {
    if (previousTarget === undefined) delete process.env.V5_LMS_SYNC_URL;
    else process.env.V5_LMS_SYNC_URL = previousTarget;
    await supabase.from('student_enrollments').delete().eq('course_slug', slug).eq('email', email);
    await supabase.from('orders').delete().eq('id', orderId);
    const { data: courseRow } = await supabase.from('courses').select('id').eq('slug', slug).maybeSingle();
    if (courseRow?.id) {
      await supabase.from('v5_course_configs').delete().eq('course_id', courseRow.id);
      await supabase.from('courses').delete().eq('id', courseRow.id);
    }
    await supabase.from('students').delete().eq('email', email);
    if (allPassed) await supabase.from('courses').delete().eq('id', markerId);
  }
}

main().catch(error => {
  console.error('[V5_BUILD_GATE] FAIL', error?.stack || error?.message || error);
  process.exit(1);
});
