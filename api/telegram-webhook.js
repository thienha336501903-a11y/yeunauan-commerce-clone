import crypto from 'crypto';
import { supabase } from '../utils/supabase.js';
import {
  approveTelegramJoin,
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

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
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
    `✅ Kết nối thành công!\n\nKhóa: ${course.title || course.slug}\nTelegram: ${title}\nChat ID: ${shared.chat_id}\n\nTừ giờ mỗi order Telegram của khóa này có thể nhận một link xin gia nhập riêng.`,
    true
  );
  return true;
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
      const join = update.chat_join_request;
      const inviteLink = join.invite_link?.invite_link;
      if (!inviteLink) return res.status(200).json({ ok: true });
      const { data: order, error } = await supabase.from('orders').select('*').eq('delivery_mode', 'telegram').eq('telegram_invite_link', inviteLink).maybeSingle();
      if (error) throw error;
      if (!order || String(order.telegram_chat_id) !== String(join.chat?.id)) return res.status(200).json({ ok: true });
      if (order.telegram_join_update_id && Number(order.telegram_join_update_id) === Number(update.update_id)) return res.status(200).json({ ok: true });
      const { data: updated, error: updateError } = await supabase.from('orders').update({
        telegram_user_id: join.from?.id || null,
        telegram_username: join.from?.username || null,
        telegram_first_name: join.from?.first_name || null,
        telegram_join_status: 'requested',
        telegram_join_requested_at: new Date().toISOString(),
        telegram_join_update_id: update.update_id || null,
        updated_at: new Date().toISOString()
      }).eq('id', order.id).select().single();
      if (updateError) throw updateError;
      try { await notifyAdminJoinRequest(updated, join.from); } catch (notifyErr) { console.error('TELEGRAM_ADMIN_NOTIFY_ERROR:', notifyErr); }
      return res.status(200).json({ ok: true });
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      if (!(await isAllowedTelegramAdmin(cb.from?.id))) {
        try { await answerTelegramCallback(cb.id, 'Bạn không có quyền duyệt đơn.'); } catch {}
        return res.status(200).json({ ok: true });
      }
      const match = /^(tgapprove|tgdecline):([0-9a-f-]{36})$/i.exec(String(cb.data || ''));
      if (!match) return res.status(200).json({ ok: true });
      const action = match[1];
      const orderId = match[2];
      const { data: order, error } = await supabase.from('orders').select('*').eq('id', orderId).eq('delivery_mode', 'telegram').maybeSingle();
      if (error) throw error;
      if (!order || !order.telegram_user_id || !order.telegram_chat_id) {
        try { await answerTelegramCallback(cb.id, 'Đơn chưa có yêu cầu tham gia hợp lệ.'); } catch {}
        return res.status(200).json({ ok: true });
      }
      if (action === 'tgapprove') {
        await approveTelegramJoin(order.telegram_chat_id, order.telegram_user_id);
        await supabase.from('orders').update({ status: 'Đã duyệt', telegram_join_status: 'approved', telegram_join_decided_at: new Date().toISOString(), sync_lms_status: 'SKIPPED_TELEGRAM', sync_portal_status: 'SKIPPED_TELEGRAM', updated_at: new Date().toISOString() }).eq('id', order.id);
        await answerTelegramCallback(cb.id, 'Đã duyệt học viên vào khóa Telegram.');
      } else {
        await declineTelegramJoin(order.telegram_chat_id, order.telegram_user_id);
        await supabase.from('orders').update({ status: 'Từ chối', telegram_join_status: 'declined', telegram_join_decided_at: new Date().toISOString(), sync_lms_status: 'SKIPPED_TELEGRAM', sync_portal_status: 'SKIPPED_TELEGRAM', updated_at: new Date().toISOString() }).eq('id', order.id);
        await answerTelegramCallback(cb.id, 'Đã từ chối yêu cầu tham gia.');
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('TELEGRAM_WEBHOOK_ERROR:', error);
    return res.status(500).json({ ok: false });
  }
}
