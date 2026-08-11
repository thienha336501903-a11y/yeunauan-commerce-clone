import crypto from 'crypto';
import { supabase } from '../utils/supabase.js';
import { approveTelegramJoin, declineTelegramJoin, answerTelegramCallback, isAllowedTelegramAdmin, notifyAdminJoinRequest } from '../utils/telegram.js';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const expected = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (!expected) return res.status(503).json({ ok: false });
  if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'], expected)) return res.status(401).json({ ok: false });

  try {
    const update = req.body || {};
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
      if (!isAllowedTelegramAdmin(cb.from?.id)) {
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
