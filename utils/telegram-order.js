// Telegram course orders: one place for approve / decline / revoke / new invite, used by the bot buttons
// (api/telegram-webhook.js) and Admin orders.html (api/orders.js). Every step first claims the order with an
// optimistic lock on (telegram_join_status, updated_at), so two clicks or a Telegram retry never act twice.
import { supabase } from './supabase.js';
import * as telegram from './telegram.js';

const STALE_MS = 2 * 60 * 1000; // a step left half-done (crash between Telegram and DB) can be retried after this
const ALREADY_MEMBER = /USER_ALREADY_PARTICIPANT/i;
const REQUEST_GONE = /HIDE_REQUESTER_MISSING|USER_NOT_PARTICIPANT|request.*not found/i;
const WAITING = 'Chờ duyệt';
const APPROVED = 'Đã duyệt';
const REJECTED = 'Từ chối';
const BUSY = new Set(['approving', 'declining', 'revoking', 'invite_creating']);
const IN_CHAT = new Set(['member', 'administrator', 'creator', 'restricted']);
const OUT_OF_CHAT = new Set(['left', 'kicked']);

const fail = (statusCode, error, code) => ({ ok: false, statusCode, error, code });
const nowIso = () => new Date().toISOString();
const errText = error => String(error?.message || error || 'Lỗi không rõ').slice(0, 300);

function isStale(order) {
  const at = Date.parse(order.updated_at || '');
  return !Number.isFinite(at) || Date.now() - at > STALE_MS;
}

// Moves the order to a busy state only if nobody changed it since `order` was read.
async function claim(db, order, busyStatus) {
  let query = db.from('orders')
    .update({ telegram_join_status: busyStatus, updated_at: nowIso() })
    .eq('id', order.id);
  query = order.telegram_join_status == null ? query.is('telegram_join_status', null) : query.eq('telegram_join_status', order.telegram_join_status);
  query = order.updated_at == null ? query.is('updated_at', null) : query.eq('updated_at', order.updated_at);
  const { data, error } = await query.select().maybeSingle();
  if (error) throw error;
  return data;
}

async function save(db, id, patch, onlyIfJoinStatus) {
  let query = db.from('orders').update({ ...patch, updated_at: nowIso() }).eq('id', id);
  if (onlyIfJoinStatus) query = query.eq('telegram_join_status', onlyIfJoinStatus); // still ours: a stale re-claim did not take over
  const { data, error } = await query.select().maybeSingle();
  if (error) throw error;
  return data;
}

// Audit trail kept on the order (raw_data.telegram_history, last 20): who did what, when, and the result.
function withHistory(order, entry) {
  const raw = order?.raw_data && typeof order.raw_data === 'object' ? order.raw_data : {};
  const past = Array.isArray(raw.telegram_history) ? raw.telegram_history.slice(-19) : [];
  return { ...raw, telegram_history: [...past, { at: nowIso(), ...entry }] };
}

function busyBlocked(order) {
  return BUSY.has(order.telegram_join_status) && !isStale(order);
}

// An approval may have reached Telegram while our DB write failed: then the customer is already inside.
// Unknown (getChatMember failed) counts as inside, so a reject never leaves a member behind silently.
async function joinedAlready(order, tg) {
  if (!order.telegram_user_id || !order.telegram_chat_id) return false;
  if (!['approving', 'approve_failed'].includes(order.telegram_join_status)) return false;
  const status = await tg.getTelegramMemberStatus(order.telegram_chat_id, order.telegram_user_id);
  return status === null || IN_CHAT.has(status);
}
const JOINED_MSG = 'Khách ĐÃ (hoặc có thể đã) ở trong nhóm sau lần duyệt trước. Bấm Duyệt để ghi đơn, hoặc Duyệt rồi Từ chối để thu hồi; Telegram không trả lời thì thử lại sau.';

export async function approveTelegramOrder(order, { db = supabase, tg = telegram, by = 'admin_web' } = {}) {
  if (order.status !== WAITING) return fail(409, `Đơn đang ở trạng thái "${order.status}", không duyệt được.`, 'telegram_not_waiting');
  if (!order.telegram_user_id || !order.telegram_chat_id) return fail(409, 'Khách chưa bấm link mời để xin vào nhóm. Chờ khách gửi yêu cầu tham gia rồi mới duyệt.', 'telegram_no_request');
  const resumable = (order.telegram_join_status === 'approving' && isStale(order)) || order.telegram_join_status === 'approve_failed';
  if (order.telegram_join_status !== 'requested' && !resumable) {
    if (busyBlocked(order)) return fail(409, 'Đơn đang được xử lý, thử lại sau 2 phút.', 'telegram_busy');
    return fail(409, 'Đơn chưa có yêu cầu tham gia đang chờ (trạng thái Telegram: ' + (order.telegram_join_status || 'trống') + ').', 'telegram_no_request');
  }
  const claimed = await claim(db, order, 'approving');
  if (!claimed) return fail(409, 'Đơn vừa được xử lý ở nơi khác. Tải lại danh sách.', 'telegram_busy');

  try {
    await tg.approveTelegramJoin(order.telegram_chat_id, order.telegram_user_id);
  } catch (error) {
    const joined = ALREADY_MEMBER.test(errText(error)) || IN_CHAT.has(await tg.getTelegramMemberStatus(order.telegram_chat_id, order.telegram_user_id));
    if (!joined) {
      const gone = REQUEST_GONE.test(errText(error));
      // Gone: wait for the customer to ask again. Other errors (429, 5xx, network): the request may still be
      // pending at Telegram, so the Admin can press Duyệt again (approve_failed is approvable).
      await save(db, order.id, { telegram_join_status: 'approve_failed', sync_error: 'Telegram: ' + errText(error) });
      return fail(502, gone
        ? 'Yêu cầu tham gia không còn (khách đã huỷ hoặc quá hạn). Nhắn khách bấm lại link mời; bot sẽ báo lại để duyệt.'
        : 'Telegram không duyệt được: ' + errText(error) + '. Thử Duyệt lại sau ít phút.', gone ? 'telegram_request_gone' : 'telegram_api_error');
    }
  }

  const patch = {
    status: APPROVED, telegram_join_status: 'approved', telegram_join_decided_at: nowIso(),
    sync_lms_status: 'SKIPPED_TELEGRAM', sync_portal_status: 'SKIPPED_TELEGRAM', sync_error: null,
    raw_data: withHistory(claimed, { action: 'approve', by })
  };
  let saved = null;
  for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
    try { saved = await save(db, order.id, patch); } catch (error) { console.error('TELEGRAM_APPROVE_SAVE_ERROR:', error); }
  }
  if (!saved) return fail(500, 'Khách ĐÃ vào nhóm nhưng chưa ghi được trạng thái đơn. Sau 2 phút bấm Duyệt lại để ghi (không mời trùng).', 'telegram_saved_failed');
  try { await tg.revokeTelegramInvite(order.telegram_chat_id, order.telegram_invite_link); } catch (error) { console.error('TELEGRAM_INVITE_REVOKE_ERROR:', error); }
  return { ok: true, data: saved };
}

// Rejects an order that is not approved yet: declines a pending join request and kills the invite link.
export async function declineTelegramOrder(order, { db = supabase, tg = telegram, by = 'admin_web' } = {}) {
  if (order.status !== WAITING) return fail(409, `Đơn đang ở trạng thái "${order.status}".`, 'telegram_not_waiting');
  if (busyBlocked(order)) return fail(409, 'Đơn đang được xử lý, thử lại sau 2 phút.', 'telegram_busy');
  if (await joinedAlready(order, tg)) return fail(409, JOINED_MSG, 'telegram_already_member');
  const claimed = await claim(db, order, 'declining');
  if (!claimed) return fail(409, 'Đơn vừa được xử lý ở nơi khác. Tải lại danh sách.', 'telegram_busy');

  if (order.telegram_user_id && order.telegram_chat_id) {
    try {
      await tg.declineTelegramJoin(order.telegram_chat_id, order.telegram_user_id);
    } catch (error) {
      if (!REQUEST_GONE.test(errText(error))) {
        await save(db, order.id, { telegram_join_status: order.telegram_join_status ?? null, sync_error: 'Telegram: ' + errText(error) });
        return fail(502, 'Telegram không từ chối được: ' + errText(error), 'telegram_api_error');
      }
    }
  }
  try { await tg.revokeTelegramInvite(order.telegram_chat_id, order.telegram_invite_link); } catch (error) { console.error('TELEGRAM_INVITE_REVOKE_ERROR:', error); }
  const saved = await save(db, order.id, {
    status: REJECTED, telegram_join_status: 'declined', telegram_join_decided_at: nowIso(),
    sync_lms_status: 'SKIPPED_TELEGRAM', sync_portal_status: 'SKIPPED_TELEGRAM', sync_error: null,
    raw_data: withHistory(claimed, { action: 'decline', by })
  });
  return { ok: true, data: saved };
}

// Takes back access of an approved order: removes the member from the group, then marks the order rejected.
// Done only when Telegram says the member is out (left/kicked); a member still inside keeps the order approved.
// Channel without the ban right: the Admin removes the member by hand, presses again, and this re-checks.
export async function revokeTelegramOrder(order, { db = supabase, tg = telegram, by = 'admin_web' } = {}) {
  if (order.status !== APPROVED) return fail(409, 'Chỉ thu hồi được đơn đã duyệt.', 'telegram_not_approved');
  if (!order.telegram_user_id || !order.telegram_chat_id) return fail(409, 'Đơn không có tài khoản Telegram đã vào nhóm.', 'telegram_no_member');
  if (busyBlocked(order)) return fail(409, 'Đơn đang được xử lý, thử lại sau 2 phút.', 'telegram_busy');
  const claimed = await claim(db, order, 'revoking');
  if (!claimed) return fail(409, 'Đơn vừa được xử lý ở nơi khác. Tải lại danh sách.', 'telegram_busy');

  let removeError = null;
  try { await tg.removeTelegramMember(order.telegram_chat_id, order.telegram_user_id); } catch (error) { removeError = error; }
  const member = await tg.getTelegramMemberStatus(order.telegram_chat_id, order.telegram_user_id);
  // Ban worked but unban failed: lift the ban so a later paid order can invite them again.
  if (member === 'kicked') {
    try { await tg.unbanTelegramMember(order.telegram_chat_id, order.telegram_user_id); } catch (unbanError) { console.error('TELEGRAM_UNBAN_ERROR:', unbanError); }
  }
  const out = OUT_OF_CHAT.has(member) || (!removeError && member !== null && !IN_CHAT.has(member));
  if (!out) {
    const why = removeError ? errText(removeError) : (member === null ? 'Telegram không trả lời trạng thái thành viên' : 'học viên vẫn còn trong nhóm/kênh');
    await save(db, order.id, {
      telegram_join_status: 'approved', sync_error: 'Telegram thu hồi: ' + why,
      raw_data: withHistory(claimed, { action: 'revoke_failed', by, member: member || 'unknown', error: why.slice(0, 200) })
    });
    return fail(409, member === null
      ? 'Chưa xác nhận được học viên đã rời nhóm/kênh (Telegram không trả lời). Đơn vẫn ĐÃ DUYỆT. Thử lại sau ít phút.'
      : 'Học viên VẪN CÒN trong nhóm/kênh, chưa thu hồi. Bot chưa có quyền "Cấm thành viên" (Ban users): xoá học viên bằng tay trong Telegram rồi bấm "Thu hồi quyền học" lần nữa để hệ thống kiểm tra lại.',
    member === null ? 'telegram_member_unknown' : 'telegram_still_member');
  }
  const saved = await save(db, order.id, {
    status: REJECTED, telegram_join_status: 'revoked', sync_error: null,
    raw_data: withHistory(claimed, { action: 'revoke', by, member, manual: Boolean(removeError) })
  }, 'revoking');
  if (!saved) return fail(409, 'Đơn vừa được xử lý ở nơi khác. Tải lại danh sách.', 'telegram_busy');
  return { ok: true, data: saved };
}

// New invite link for a waiting order (old link expired, failed or lost). Unbinds a failed requester.
export async function reissueTelegramInvite(order, { db = supabase, tg = telegram } = {}) {
  if (order.status !== WAITING) return fail(409, 'Chỉ tạo lại link cho đơn đang chờ duyệt.', 'telegram_not_waiting');
  if (order.telegram_join_status === 'requested') return fail(409, 'Khách đã gửi yêu cầu tham gia: hãy Duyệt hoặc Từ chối, không cần link mới.', 'telegram_has_request');
  if (busyBlocked(order)) return fail(409, 'Đơn đang được xử lý, thử lại sau 2 phút.', 'telegram_busy');
  if (!order.telegram_chat_id) return fail(409, 'Đơn chưa gắn group/channel Telegram.', 'telegram_no_chat');
  if (await joinedAlready(order, tg)) return fail(409, JOINED_MSG, 'telegram_already_member');
  const { data: course, error: courseError } = await db.from('courses').select('telegram_invite_ttl_hours').eq('id', order.course_id).maybeSingle();
  if (courseError) throw courseError;
  const claimed = await claim(db, order, 'invite_creating');
  if (!claimed) return fail(409, 'Đơn vừa được xử lý ở nơi khác. Tải lại danh sách.', 'telegram_busy');

  try { await tg.revokeTelegramInvite(order.telegram_chat_id, order.telegram_invite_link); } catch (error) { console.error('TELEGRAM_INVITE_REVOKE_ERROR:', error); }
  let invite;
  try {
    invite = await tg.createOrderInvite({ chatId: order.telegram_chat_id, orderId: order.id, courseSlug: order.course_slug, ttlHours: course?.telegram_invite_ttl_hours || 72 });
  } catch (error) {
    await save(db, order.id, { telegram_join_status: 'invite_error', sync_error: 'Telegram: ' + errText(error) });
    return fail(502, 'Telegram không tạo được link mời: ' + errText(error), 'telegram_api_error');
  }
  const saved = await save(db, order.id, {
    telegram_invite_link: invite.inviteLink, telegram_invite_name: invite.inviteName, telegram_invite_expires_at: invite.expiresAt,
    telegram_join_status: 'invite_ready', telegram_user_id: null, telegram_username: null, telegram_first_name: null,
    telegram_join_requested_at: null, telegram_join_update_id: null, sync_error: null
  });
  return { ok: true, data: saved };
}

// Admin web: status change or action on a Telegram order -> { statusCode, body }.
export async function telegramAdminAction(order, { status, action } = {}, deps) {
  let result;
  if (action === 'telegram_reissue_invite') result = await reissueTelegramInvite(order, deps);
  else if (action === 'telegram_revoke') result = await revokeTelegramOrder(order, deps);
  else if (status === APPROVED) result = await approveTelegramOrder(order, deps);
  else if (status === REJECTED) result = order.status === APPROVED ? await revokeTelegramOrder(order, deps) : await declineTelegramOrder(order, deps);
  else result = fail(409, 'Đơn Telegram chỉ đổi được sang "Đã duyệt" hoặc "Từ chối" (Từ chối đơn đã duyệt = xoá khỏi nhóm).', 'telegram_status_unsupported');
  if (!result.ok) return { statusCode: result.statusCode, body: { success: false, error: result.error, code: result.code } };
  const syncResults = { lms: 'SKIPPED_TELEGRAM', portal: 'SKIPPED_TELEGRAM', error: null };
  return { statusCode: 200, body: { success: true, data: { ...result.data, syncResults } } };
}
