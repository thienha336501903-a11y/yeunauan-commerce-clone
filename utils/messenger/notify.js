// After Admin approves a Facebook order, tell the buyer how to start learning (H4). Best effort: a Send API
// failure (outside Meta's 24-hour window, token revoked, timeout) never changes the approval result.
// G2: the result is a notice record kept in orders.raw_data.messengerNotify, so the Admin sees failures after a reload.
import { approvedMessage } from './bot.js';
import { sendMessage } from './meta.js';
import { cloneConfig } from '../clone-config.js';

// What Meta told us, as a status the Admin can act on. Only numbers and fixed words: no token, no Meta message text.
export function classifySend(sent) {
  if (sent?.ok) return sent.messageId ? { status: 'sent', reason: null } : { status: 'unknown', reason: 'no_message_id' };
  const error = String(sent?.error || '');
  if (error === 'missing_page_token') return { status: 'failed', reason: 'page_config' };
  // The request may have reached Meta: never claim it failed (a retry could message the buyer twice).
  if (error === 'graph_timeout') return { status: 'unknown', reason: 'timeout' };
  if (error === 'graph_network') return { status: 'unknown', reason: 'network' };
  const code = Number(sent?.code) || null;
  const subcode = Number(sent?.subcode) || null;
  const meta = { metaCode: code, metaSubcode: subcode };
  // A Meta server error may still have delivered the message: unknown, not failed.
  if (Number(sent?.httpStatus) >= 500) return { status: 'unknown', reason: 'meta_error', ...meta };
  if (code === 10 && subcode === 2018278) return { status: 'failed', reason: 'window', ...meta };
  if (code === 551) return { status: 'failed', reason: 'user_unavailable', ...meta };
  if (code === 190) return { status: 'failed', reason: 'page_config', ...meta };
  if (code === 4 || code === 613) return { status: 'failed', reason: 'rate_limit', ...meta };
  return { status: 'failed', reason: 'api_other', ...meta };
}

// null: not a Facebook order (nothing to send, nothing to show).
export async function notifyApprovedOrder(order, { env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  const raw = order?.raw_data || {};
  if (raw.channel !== 'facebook' || !/^\d{5,32}$/.test(String(raw.psid || ''))) return null;
  const attemptedAt = now().toISOString();
  if (String(env.MESSENGER_BOT_ENABLED || '').trim() !== '1') return { status: 'skipped', reason: 'bot_off', attemptedAt };
  const message = {
    text: approvedMessage({
      courseTitle: order.course_title || order.course_slug,
      gmail: order.customer_email,
      lmsUrl: cloneConfig(env).lmsPublicUrl // learner-facing host (V5_LMS_PUBLIC_URL is the sync target)
    })
  };
  const sent = await sendMessage(String(raw.psid), message, { token: env.META_PAGE_ACCESS_TOKEN, fetchImpl, timeoutMs: 5000 });
  return { ...classifySend(sent), attemptedAt };
}

// G2: keep the notice on the order. A new approval replaces it (and its manual mark). Never throws; false = not saved.
export async function saveApprovalNotice(db, order, notice) {
  try {
    const raw_data = { ...(order?.raw_data || {}), messengerNotify: notice };
    const { data, error } = await db.from('orders').update({ raw_data }).eq('id', order.id).eq('status', 'Đã duyệt').select('id');
    return !error && Array.isArray(data) && data.length > 0; // 0 rows: revoked meanwhile, nothing saved
  } catch {
    return false;
  }
}

// C1-1: the notice step of bulk approval (same rule as api/orders.js). The approval is already committed, so
// this never throws: a failure only becomes a warning. notice null = not a Facebook order.
export async function noticeForApproved(db, approved, deps) {
  try {
    const notice = await notifyApprovedOrder(approved, deps);
    if (!notice) return { notice: null, saved: null };
    return { notice, saved: await saveApprovalNotice(db, approved, { ...notice, approvedAt: new Date().toISOString() }) };
  } catch {
    return { notice: { status: 'unknown', reason: 'internal' }, saved: false };
  }
}

// G2: "Đã xử lý thủ công" only marks the support task: raw_data.messengerNotify.manual, nothing else.
export async function markNoticeManual(db, order, note) {
  const notice = order?.raw_data?.messengerNotify;
  if (order?.status !== 'Đã duyệt' || !notice || notice.status === 'sent') return { ok: false, status: 409, error: 'Đơn này không cần xử lý thông báo thủ công.' };
  if (notice.manual) return { ok: true, notice }; // already marked: no second write
  const manual = { at: new Date().toISOString(), note: String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) };
  const next = { ...notice, manual };
  const { data, error } = await db.from('orders').update({ raw_data: { ...order.raw_data, messengerNotify: next } }).eq('id', order.id).eq('status', 'Đã duyệt').select('id');
  if (error) return { ok: false, status: 500, error: 'Không lưu được trạng thái xử lý.' };
  if (!Array.isArray(data) || !data.length) return { ok: false, status: 409, error: 'Đơn đã đổi trạng thái, hãy tải lại trang.' };
  return { ok: true, notice: next };
}
