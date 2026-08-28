import { supabase } from './supabase.js';
import { getV5Readiness } from './v5-readiness.js';
import { syncV5EnrollmentToLms } from './v5-sync-helpers.js';

export function v5SyncFailed(syncResults) {
  if (!syncResults) return true;
  return String(syncResults.lms || '').toUpperCase() !== 'SUCCESS' || Boolean(syncResults.error);
}

async function v5OrderReadiness(order, { requireSale = true } = {}) {
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
  if (course.is_published !== true) {
    return { ok: false, code: 'v5_course_unpublished', error: 'Khóa V5 chưa Publish hoặc đã Unpublish.' };
  }
  if (requireSale && course.active !== true) {
    return { ok: false, code: 'v5_course_not_for_sale', error: 'Khóa V5 hiện chưa mở bán.' };
  }
  const readiness = await getV5Readiness(course.id);
  if (!readiness.ready) {
    return { ok: false, code: readiness.reason || 'v5_not_ready', error: 'Khóa V5 chưa có canonical Published release hợp lệ.' };
  }
  return { ok: true, course, release: readiness.release || null };
}

export async function v5ApprovalReadiness(order) {
  return v5OrderReadiness(order, { requireSale: true });
}

export async function v5ExistingAccessReadiness(order) {
  return v5OrderReadiness(order, { requireSale: false });
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

function compensationNoop(reason) {
  return { lms: 'SUCCESS', portal: 'SKIPPED_V5', error: null, compensation: reason };
}

async function currentOrderForCompensation(orderId) {
  const { data, error } = await supabase
    .from('orders')
    .select('id,status,customer_email,course_id,course_slug,delivery_mode')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function compensateOrderWriteRace(order, attemptedAction) {
  try {
    const current = await currentOrderForCompensation(order.id);
    if (!current) {
      return { lms: 'FAILED', portal: 'SKIPPED_V5', error: 'Order disappeared before V5 compensation could reconcile access.' };
    }
    const shouldHaveAccess = current.status === 'Đã duyệt';

    if (attemptedAction === 'create') {
      // The grant already succeeded. Keep it if another writer committed the
      // same approved state; otherwise revoke the exact order-owned entitlement.
      if (shouldHaveAccess) return compensationNoop('CURRENT_ORDER_ALREADY_APPROVED');
      return syncV5EnrollmentToLms(current, 'revoke');
    }

    if (attemptedAction === 'revoke') {
      // The revoke already succeeded. Keep it if the current order is no longer
      // approved; only restore when DB truth still says this order owns access.
      if (!shouldHaveAccess) return compensationNoop('CURRENT_ORDER_NO_LONGER_APPROVED');
      return syncV5EnrollmentToLms(current, 'restore');
    }

    return { lms: 'FAILED', portal: 'SKIPPED_V5', error: 'Invalid V5 compensation action.' };
  } catch (error) {
    return { lms: 'FAILED', portal: 'SKIPPED_V5', error: `V5 compensation state check failed: ${error.message || error}` };
  }
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
    const compensation = await compensateOrderWriteRace(order, 'create');
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
    const compensation = await compensateOrderWriteRace(order, 'revoke');
    const wrapped = new Error(error?.message || 'Order changed while V5 revoke was being committed.');
    wrapped.code = 'v5_order_commit_failed';
    wrapped.compensation = compensation;
    throw wrapped;
  }
  return { ok: true, data, syncResults };
}

export async function resyncV5Order(order) {
  const approved = order.status === 'Đã duyệt';
  const action = approved ? 'restore' : 'revoke';
  if (approved) {
    const gate = await v5ExistingAccessReadiness(order);
    if (!gate.ok) return { ...gate, statusCode: 409 };
  }
  const syncResults = await syncV5EnrollmentToLms(order, action);
  const data = await persistSyncState(order.id, syncResults);
  if (v5SyncFailed(syncResults)) return syncConflict(syncResults);
  return { ok: true, data, syncResults };
}
