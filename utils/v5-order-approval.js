import { supabase } from './supabase.js';
import { getV5Readiness } from './v5-readiness.js';
import { syncV5EnrollmentToLms } from './v5-sync-helpers.js';

export function v5SyncFailed(syncResults) {
  if (!syncResults) return true;
  return String(syncResults.lms || '').toUpperCase() !== 'SUCCESS' || Boolean(syncResults.error);
}

export async function v5ApprovalReadiness(order) {
  if (String(order?.delivery_mode || '').toLowerCase() !== 'v5') return { ok: true };
  const courseId = String(order.course_id || '').trim();
  const courseSlug = String(order.course_slug || '').trim();
  let query = supabase.from('courses').select('id,slug,delivery_mode,active,is_published');
  query = courseId ? query.eq('id', courseId) : query.eq('slug', courseSlug);
  const { data: course, error } = await query.maybeSingle();
  if (error) throw error;
  if (!course || String(course.delivery_mode || '').toLowerCase() !== 'v5') {
    return { ok: false, code: 'v5_course_not_found', error: 'Khóa V5 của đơn hàng không còn hợp lệ.' };
  }
  if (course.active !== true || course.is_published !== true) {
    return { ok: false, code: 'v5_course_not_for_sale', error: 'Khóa V5 chưa mở bán hoặc chưa Publish.' };
  }
  const readiness = await getV5Readiness(course.id);
  if (!readiness.ready) {
    return { ok: false, code: readiness.reason || 'v5_not_ready', error: 'Khóa V5 chưa có canonical Published release hợp lệ.' };
  }
  return { ok: true, course, release: readiness.release || null };
}

async function persistSyncState(orderId, syncResults) {
  const { data, error } = await supabase.from('orders').update({
    sync_lms_status: syncResults?.lms || 'FAILED',
    sync_portal_status: syncResults?.portal || 'SKIPPED_V5',
    sync_error: syncResults?.error || null,
    updated_at: new Date().toISOString()
  }).eq('id', orderId).select().maybeSingle();
  if (error) throw error;
  return data || null;
}

function syncConflict(syncResults, fallback) {
  const message = syncResults?.error || fallback || 'Đồng bộ quyền học V5 thất bại.';
  return { ok: false, statusCode: 409, error: message, code: 'v5_enrollment_sync_failed', syncResults };
}

export async function approveV5Order(order, updatePatch = {}) {
  const gate = await v5ApprovalReadiness(order);
  if (!gate.ok) return { ...gate, statusCode: 409 };
  if (!String(order.customer_email || '').trim()) {
    return { ok: false, statusCode: 400, code: 'v5_missing_email', error: 'Đơn V5 chưa có Gmail học viên.' };
  }

  const syncResults = await syncV5EnrollmentToLms(order, 'create');
  if (v5SyncFailed(syncResults)) {
    await persistSyncState(order.id, syncResults);
    return syncConflict(syncResults, 'Không thể cấp quyền học V5; đơn vẫn ở Chờ duyệt.');
  }

  const { data, error } = await supabase.from('orders').update({
    ...updatePatch,
    status: 'Đã duyệt',
    sync_lms_status: syncResults.lms,
    sync_portal_status: syncResults.portal,
    sync_error: syncResults.error,
    updated_at: new Date().toISOString()
  }).eq('id', order.id).eq('status', order.status).select().maybeSingle();

  if (error || !data) {
    // Enrollment is owned by this exact order id, so compensation cannot revoke
    // another Commerce/manual grant after the LMS ownership hardening.
    const compensation = await syncV5EnrollmentToLms(order, 'revoke');
    const wrapped = new Error(error?.message || 'Order changed while V5 approval was being committed.');
    wrapped.code = 'v5_order_commit_failed';
    wrapped.compensation = compensation;
    throw wrapped;
  }
  return { ok: true, data, syncResults };
}

export async function revokeV5Order(order, nextStatus, updatePatch = {}) {
  const syncResults = await syncV5EnrollmentToLms(order, 'revoke');
  if (v5SyncFailed(syncResults)) {
    await persistSyncState(order.id, syncResults);
    return syncConflict(syncResults, 'Không thể thu hồi quyền V5; trạng thái đơn chưa thay đổi.');
  }

  const { data, error } = await supabase.from('orders').update({
    ...updatePatch,
    status: nextStatus,
    sync_lms_status: syncResults.lms,
    sync_portal_status: syncResults.portal,
    sync_error: syncResults.error,
    updated_at: new Date().toISOString()
  }).eq('id', order.id).eq('status', order.status).select().maybeSingle();

  if (error || !data) {
    // Best-effort restore when the order write loses a race/fails. Creation is
    // independently gated by canonical readiness in LMS, so it cannot grant an
    // unpublished course. If restore cannot run, surface the inconsistency.
    const compensation = order.status === 'Đã duyệt'
      ? await syncV5EnrollmentToLms(order, 'create')
      : null;
    const wrapped = new Error(error?.message || 'Order changed while V5 revoke was being committed.');
    wrapped.code = 'v5_order_commit_failed';
    wrapped.compensation = compensation;
    throw wrapped;
  }
  return { ok: true, data, syncResults };
}

export async function resyncV5Order(order) {
  const action = order.status === 'Đã duyệt' ? 'create' : 'revoke';
  if (action === 'create') {
    const gate = await v5ApprovalReadiness(order);
    if (!gate.ok) return { ...gate, statusCode: 409 };
  }
  const syncResults = await syncV5EnrollmentToLms(order, action);
  const data = await persistSyncState(order.id, syncResults);
  if (v5SyncFailed(syncResults)) return syncConflict(syncResults);
  return { ok: true, data, syncResults };
}
