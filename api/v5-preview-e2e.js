import crypto from 'node:crypto';
import { supabase } from '../utils/supabase.js';
import { syncV5CourseToLms } from '../utils/v5-sync-helpers.js';
import approveAllHandler from './approve-all.js';
import ordersHandler from './orders.js';

const PROBE_TOKEN = 'ZJjemvYi2vrS16cHaGSQKtmGV6gmEg19z52GuQVDtaU';
const LMS_V5_PREVIEW = 'https://yeunauan-lms-v4-test-git-bb43d1-thienha336501903-a11ys-projects.vercel.app';
const PREFIX = '__clone_factory_test_v5_cross_repo_';

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (process.env.VERCEL_ENV !== 'preview') return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (String(req.query?.token || '') !== PROBE_TOKEN) return res.status(404).json({ error: 'Not found' });

  const suffix = crypto.randomBytes(6).toString('hex');
  const slug = `clone-factory-test-v5-${suffix}`;
  const title = `${PREFIX}${suffix}`;
  const email = `${PREFIX}${suffix}@example.com`;
  const orderId = crypto.randomUUID();
  const previousTarget = process.env.V5_LMS_SYNC_URL;
  const checks = [];

  const check = (name, ok, detail = null) => {
    checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) throw new Error(`CHECK_FAILED:${name}${detail ? ':' + detail : ''}`);
  };

  try {
    process.env.V5_LMS_SYNC_URL = LMS_V5_PREVIEW;

    const courseSync = await syncV5CourseToLms({
      slug,
      courseName: title,
      description: 'Temporary isolated V5 cross-repo E2E fixture',
      active: true
    });
    check('syncCourse_to_LMS_V5_preview', courseSync.lms === 'SUCCESS' && courseSync.portal === 'SKIPPED_V5', JSON.stringify(courseSync));

    const { data: course, error: courseError } = await supabase.from('courses').select('id,slug,delivery_mode').eq('slug', slug).single();
    if (courseError) throw courseError;
    check('course_is_v5', String(course.delivery_mode).toLowerCase() === 'v5');

    const now = new Date().toISOString();
    const { error: publishError } = await supabase.from('courses').update({ active: true, is_published: true, updated_at: now }).eq('id', course.id);
    if (publishError) throw publishError;
    const { error: configError } = await supabase.from('v5_course_configs').upsert({ course_id: course.id, source_mode: 'direct', status: 'published', updated_at: now }, { onConflict: 'course_id' });
    if (configError) throw configError;

    const { error: orderError } = await supabase.from('orders').insert({
      id: orderId,
      course_id: course.id,
      course_slug: slug,
      course_title: title,
      customer_email: email,
      proof_image_url: 'https://example.com/test-only.png',
      status: 'Chờ duyệt',
      delivery_mode: 'v5',
      raw_data: { billName: `${PREFIX}${suffix}.png`, probe: true }
    });
    if (orderError) throw orderError;

    const adminHeaders = { 'x-admin-password': process.env.ADMIN_PASSWORD };
    const approved = await invoke(approveAllHandler, { method: 'POST', headers: adminHeaders, body: { course: slug } });
    check('bulk_approve_http_200', approved.statusCode === 200, JSON.stringify(approved.body));
    check('bulk_approve_count_1', approved.body?.count === 1, JSON.stringify(approved.body));
    check('bulk_approve_sync_success', approved.body?.syncSucceeded === 1 && approved.body?.syncFailed === 0, JSON.stringify(approved.body));

    let { data: orderAfterApprove, error: readOrderError } = await supabase.from('orders').select('status,sync_lms_status,sync_portal_status,sync_error').eq('id', orderId).single();
    if (readOrderError) throw readOrderError;
    check('order_approved', orderAfterApprove.status === 'Đã duyệt', JSON.stringify(orderAfterApprove));
    check('order_v5_sync_status', orderAfterApprove.sync_lms_status === 'SUCCESS' && orderAfterApprove.sync_portal_status === 'SKIPPED_V5', JSON.stringify(orderAfterApprove));

    let { data: enrollment, error: enrollmentError } = await supabase.from('student_enrollments').select('status,source_system,source_order_id,expired_at').eq('email', email).eq('course_slug', slug).single();
    if (enrollmentError) throw enrollmentError;
    check('enrollment_active', enrollment.status === 'active', JSON.stringify(enrollment));
    check('enrollment_source_commerce_v5', enrollment.source_system === 'commerce_v5' && enrollment.source_order_id === orderId, JSON.stringify(enrollment));

    const resyncApproved = await invoke(ordersHandler, { method: 'PUT', headers: adminHeaders, body: { id: orderId, action: 'resync' } });
    check('approved_resync_http_200', resyncApproved.statusCode === 200, JSON.stringify(resyncApproved.body));
    check('approved_resync_success', resyncApproved.body?.data?.syncResults?.lms === 'SUCCESS' && resyncApproved.body?.data?.syncResults?.portal === 'SKIPPED_V5', JSON.stringify(resyncApproved.body));

    const revoke = await invoke(ordersHandler, { method: 'PUT', headers: adminHeaders, body: { id: orderId, status: 'Từ chối', note: 'temporary V5 E2E revoke' } });
    check('revoke_http_200', revoke.statusCode === 200, JSON.stringify(revoke.body));
    check('revoke_sync_success', revoke.body?.data?.syncResults?.lms === 'SUCCESS' && revoke.body?.data?.syncResults?.portal === 'SKIPPED_V5', JSON.stringify(revoke.body));

    ({ data: enrollment, error: enrollmentError } = await supabase.from('student_enrollments').select('status,source_system,source_order_id').eq('email', email).eq('course_slug', slug).single());
    if (enrollmentError) throw enrollmentError;
    check('enrollment_revoked', enrollment.status === 'revoked', JSON.stringify(enrollment));

    const resyncRevoked = await invoke(ordersHandler, { method: 'PUT', headers: adminHeaders, body: { id: orderId, action: 'resync' } });
    check('revoked_resync_http_200', resyncRevoked.statusCode === 200, JSON.stringify(resyncRevoked.body));
    check('revoked_resync_idempotent', resyncRevoked.body?.data?.syncResults?.lms === 'SUCCESS', JSON.stringify(resyncRevoked.body));

    return res.status(200).json({ success: true, slug, email, checks });
  } catch (error) {
    console.error('[v5-preview-e2e]', error);
    return res.status(500).json({ success: false, error: error.message || String(error), slug, email, checks });
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
  }
}
