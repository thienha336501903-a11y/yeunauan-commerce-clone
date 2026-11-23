import crypto from 'crypto';
import { supabase } from '../utils/supabase.js';
import {
  declineTelegramJoin,
  answerTelegramCallback,
  getTelegramWebhookSecret,
  isAllowedTelegramAdmin,
  notifyAdminJoinRequest,
  sendCourseChatPicker,
  sendTelegramPrivateMessage,
  verifyBotInvitePermission,
  verifyCourseConnectToken
} from '../utils/telegram.js';
import { approveTelegramOrder, declineTelegramOrder } from '../utils/telegram-order.js';

function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return false;
  const x = Buffer.from(left, 'utf8');
  const y = Buffer.from(right, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function randomTelegramRequestId() {
  return crypto.randomInt(100000, 2147483645);
}

async function handleCourseConnectStart(message) {
  if (message?.chat?.type !== 'private') return false;
  const text = String(message.text || '').trim();
  const match = /^\/start(?:@\w+)?\s+(.+)$/.exec(text);
  if (!match) return false;

  const adminUserId = message.from?.id;
  if (!(await isAllowedTelegramAdmin(adminUserId))) {
    await sendTelegramPrivateMessage(message.chat.id, 'Bạn không có quyền kết nối khóa học Telegram cho hệ thống này.', true);
    return true;
  }

  const courseId = await verifyCourseConnectToken(match[1]);
  if (!courseId) {
    await sendTelegramPrivateMessage(message.chat.id, 'Link kết nối Telegram không hợp lệ hoặc đã bị chỉnh sửa. Hãy tạo lại link từ trang Admin.', true);
    return true;
  }

  const { data: course, error } = await supabase
    .from('courses')
    .select('id, slug, title, delivery_mode, telegram_chat_id, telegram_chat_title')
    .eq('id', courseId)
    .maybeSingle();
  if (error) throw error;
  if (!course || course.delivery_mode !== 'telegram') {
    await sendTelegramPrivateMessage(message.chat.id, 'Không tìm thấy khóa học Telegram tương ứng. Hãy quay lại trang Admin và thử lại.', true);
    return true;
  }

  const requestId = randomTelegramRequestId();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { error: updateError } = await supabase
    .from('courses')
    .update({
      telegram_connect_request_id: requestId,
      telegram_connect_user_id: Number(adminUserId),
      telegram_connect_expires_at: expiresAt
    })
    .eq('id', course.id);
  if (updateError) throw updateError;

  await sendCourseChatPicker({ adminChatId: message.chat.id, course, requestId });
  return true;
}

async function handleSharedChat(message) {
  if (message?.chat?.type !== 'private' || !message.chat_shared) return false;
  const adminUserId = message.from?.id;
  if (!(await isAllowedTelegramAdmin(adminUserId))) {
    await sendTelegramPrivateMessage(message.chat.id, 'Bạn không có quyền gắn group/channel vào khóa học.', true);
    return true;
  }

  const requestId = Number(message.chat_shared.request_id);
  const possibleBaseIds = [requestId, requestId - 1].filter(v => Number.isInteger(v) && v > 0);
  const { data: courses, error } = await supabase
    .from('courses')
    .select('id, slug, title, telegram_connect_request_id, telegram_connect_user_id, telegram_connect_expires_at')
    .eq('delivery_mode', 'telegram')
    .eq('telegram_connect_user_id', Number(adminUserId))
    .in('telegram_connect_request_id', possibleBaseIds)
    .limit(2);
  if (error) throw error;

  const now = Date.now();
  const course = (courses || []).find(item => {
    const base = Number(item.telegram_connect_request_id);
    const validRequest = requestId === base || requestId === base + 1;
    const validExpiry = item.telegram_connect_expires_at && new Date(item.telegram_connect_expires_at).getTime() > now;
    return validRequest && validExpiry;
  });

  if (!course) {
    await sendTelegramPrivateMessage(message.chat.id, 'Phiên kết nối đã hết hạn hoặc không khớp khóa học. Hãy bấm “Kết nối Telegram” lại trên trang Admin.', true);
    return true;
  }

  const shared = message.chat_shared;
  let permission;
  try {
    permission = await verifyBotInvitePermission(shared.chat_id);
  } catch (error) {
    await sendTelegramPrivateMessage(message.chat.id, `Telegram đã chọn chat nhưng bot chưa truy cập được chat đó. Hãy đảm bảo bot được cấp quyền Admin và quyền mời thành viên.\n\nChi tiết: ${error.message || error}`, true);
    return true;
  }

  if (!permission.ok) {
    await sendTelegramPrivateMessage(message.chat.id, 'Bot chưa có đủ quyền Admin / mời thành viên trong group hoặc channel vừa chọn. Hãy cấp quyền rồi kết nối lại.', true);
    return true;
  }

  const title = String(shared.title || '').trim() || String(shared.username || '').trim() || `Telegram ${shared.chat_id}`;
  const { error: bindError } = await supabase
    .from('courses')
    .update({
      telegram_chat_id: String(shared.chat_id),
      telegram_chat_title: title,
      telegram_connect_request_id: null,
      telegram_connect_user_id: null,
      telegram_connect_expires_at: null,
      updated_at: new Date().toISOString()
    })
    .eq('id', course.id);
  if (bindError) throw bindError;

  await sendTelegramPrivateMessage(
    message.chat.id,
    `✅ Kết nối thành công!\n\nKhóa: ${course.title || course.slug}\nTelegram: ${title}\nChat ID: ${shared.chat_id}\n\nTừ giờ mỗi order Telegram của khóa này có thể nhận một link xin gia nhập riêng.${permission.canRestrict ? '' : '\n\n⚠️ Bot chưa có quyền "Cấm thành viên" (Ban users): hệ thống không tự xoá được học viên khi thu hồi đơn. Với nhóm, cấp quyền này cho bot; với kênh, Admin xoá tay.'}`,
    true
  );
  return true;
}

async function declineUnexpectedRequester(order, joinUserId) {
  if (!joinUserId || !order?.telegram_chat_id) return;
  try {
    await declineTelegramJoin(order.telegram_chat_id, joinUserId);
  } catch (error) {
    console.error('TELEGRAM_UNEXPECTED_REQUESTER_DECLINE_ERROR:', error);
  }
}

// A customer opened the order's invite link. The first Telegram account binds to the order; the Admin
// then approves or declines with the bot buttons (or in orders.html). Nobody joins without that approval.
async function handleJoinRequest(join, updateId) {
  const inviteLink = join.invite_link?.invite_link;
  const joinUserId = join.from?.id;
  if (!inviteLink || !joinUserId) return;

  const { data: order, error } = await supabase.from('orders').select('*').eq('delivery_mode', 'telegram').eq('telegram_invite_link', inviteLink).maybeSingle();
  if (error) throw error;
  if (!order || String(order.telegram_chat_id) !== String(join.chat?.id)) return;
  if (order.telegram_join_update_id && Number(order.telegram_join_update_id) === Number(updateId)) return;
  // Rejected or already handled order: its link must not let anyone in.
  if (order.status !== 'Chờ duyệt') { await declineUnexpectedRequester(order, joinUserId); return; }

  const sameUser = order.telegram_user_id && String(order.telegram_user_id) === String(joinUserId);
  if (order.telegram_user_id && !sameUser) { await declineUnexpectedRequester(order, joinUserId); return; }
  // Same person again: only a failed approval (request had expired) reopens the request.
  if (sameUser && order.telegram_join_status !== 'approve_failed') return;

  let query = supabase.from('orders').update({
    telegram_user_id: joinUserId,
    telegram_username: join.from?.username || null,
    telegram_first_name: join.from?.first_name || null,
    telegram_join_status: 'requested',
    telegram_join_requested_at: new Date().toISOString(),
    telegram_join_update_id: updateId || null,
    sync_error: null,
    updated_at: new Date().toISOString()
  }).eq('id', order.id).eq('status', 'Chờ duyệt');
  query = sameUser
    ? query.eq('telegram_user_id', joinUserId).eq('telegram_join_status', 'approve_failed')
    : query.is('telegram_user_id', null).eq('telegram_join_status', 'invite_ready');
  const { data: updated, error: updateError } = await query.select().maybeSingle();
  if (updateError) throw updateError;

  if (!updated) {
    const { data: current, error: currentError } = await supabase.from('orders').select('*').eq('id', order.id).maybeSingle();
    if (currentError) throw currentError;
    if (current?.telegram_user_id && String(current.telegram_user_id) !== String(joinUserId)) await declineUnexpectedRequester(current, joinUserId);
    return;
  }

  // Warn the Admin when this Telegram account already paid for the same group (two orders, one seat).
  const { data: other } = await supabase.from('orders').select('id').eq('delivery_mode', 'telegram')
    .eq('telegram_chat_id', String(updated.telegram_chat_id)).eq('telegram_user_id', joinUserId)
    .eq('status', 'Đã duyệt').neq('id', updated.id).limit(1);
  try {
    await notifyAdminJoinRequest({ ...updated, duplicateApprovedOrderId: other?.[0]?.id || null }, join.from);
  } catch (notifyErr) {
    console.error('TELEGRAM_ADMIN_NOTIFY_ERROR:', notifyErr);
    await supabase.from('orders').update({ sync_error: 'Chưa báo được Admin qua bot: duyệt đơn này trong orders.html.' }).eq('id', updated.id);
  }
}

// Bot buttons DUYỆT / TỪ CHỐI. Never throws for a Telegram or state problem: a 500 makes Telegram resend the update.
async function handleDecisionButton(cb) {
  const answer = async (text, alert = false) => { try { await answerTelegramCallback(cb.id, text, alert); } catch {} };
  if (!(await isAllowedTelegramAdmin(cb.from?.id))) return answer('Bạn không có quyền duyệt đơn.', true);
  const match = /^(tgapprove|tgdecline):([0-9a-f-]{36})$/i.exec(String(cb.data || ''));
  if (!match) return answer('Nút không hợp lệ.');
  const { data: order, error } = await supabase.from('orders').select('*').eq('id', match[2]).eq('delivery_mode', 'telegram').maybeSingle();
  if (error) throw error;
  if (!order) return answer('Không tìm thấy đơn.', true);
  if (order.status !== 'Chờ duyệt') return answer(`Đơn này đã xử lý: ${order.status}.`, true);
  const result = match[1].toLowerCase() === 'tgapprove' ? await approveTelegramOrder(order) : await declineTelegramOrder(order);
  if (!result.ok) return answer(result.error, true);
  return answer(match[1].toLowerCase() === 'tgapprove' ? 'Đã duyệt học viên vào khóa Telegram.' : 'Đã từ chối yêu cầu tham gia.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  let expected;
  try {
    expected = await getTelegramWebhookSecret();
  } catch {
    return res.status(503).json({ ok: false });
  }
  if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'], expected)) return res.status(401).json({ ok: false });

  try {
    const update = req.body || {};

    if (update.message) {
      if (await handleCourseConnectStart(update.message)) return res.status(200).json({ ok: true });
      if (await handleSharedChat(update.message)) return res.status(200).json({ ok: true });
    }

    if (update.chat_join_request) {
      await handleJoinRequest(update.chat_join_request, update.update_id);
      return res.status(200).json({ ok: true });
    }

    if (update.callback_query) {
      await handleDecisionButton(update.callback_query);
      return res.status(200).json({ ok: true });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('TELEGRAM_WEBHOOK_ERROR:', error);
    return res.status(500).json({ ok: false });
  }
}
