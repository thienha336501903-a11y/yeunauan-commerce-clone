import crypto from 'crypto';
import { supabase } from '../utils/supabase.js';
import { createCourseConnectToken, telegramApi, telegramBotSnapshot, verifyBotInvitePermission } from '../utils/telegram.js';
import { enforceSameOriginAdminRequest } from '../utils/admin-cors.js';

function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return false;
  const x = Buffer.from(left, 'utf8');
  const y = Buffer.from(right, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function getCourse(courseId) {
  const { data, error } = await supabase
    .from('courses')
    .select('id, slug, title, delivery_mode, raw_data, telegram_chat_id, telegram_chat_title, telegram_connect_expires_at')
    .eq('id', courseId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export default async function handler(req, res) {
  if (!enforceSameOriginAdminRequest(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!safeEqual(req.headers['x-admin-password'], process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const courseId = String(req.method === 'GET' ? req.query.courseId || '' : req.body?.courseId || '').trim();
  if (!courseId) return res.status(400).json({ error: 'Thiếu courseId' });

  try {
    const course = await getCourse(courseId);
    if (!course) return res.status(404).json({ error: 'Không tìm thấy khóa học' });
    if (course.delivery_mode !== 'telegram') return res.status(409).json({ error: 'Khóa học này chưa chọn hình thức Telegram' });

    if (req.method === 'GET') {
      const connected = Boolean(String(course.telegram_chat_id || '').trim());
      let telegramBot = course.raw_data?.telegramBot || null;
      // check=1: ask Telegram again what the bot may do in the connected chat, and keep the answer.
      if (connected && String(req.query.check || '') === '1') {
        let permission;
        try { permission = await verifyBotInvitePermission(course.telegram_chat_id); } catch (error) { permission = { ok: false, canRestrict: false, member: { status: 'unreachable' }, error: error.message || String(error) }; }
        telegramBot = { ...telegramBotSnapshot(permission, telegramBot?.chatType), ...(permission.error ? { error: String(permission.error).slice(0, 200) } : {}) };
        const { error: saveError } = await supabase.from('courses').update({ raw_data: { ...(course.raw_data || {}), telegramBot } }).eq('id', course.id);
        if (saveError) throw saveError;
      }
      const { count: approvedOrders, error: countError } = await supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('course_slug', course.slug).eq('delivery_mode', 'telegram').eq('status', 'Đã duyệt');
      if (countError) throw countError;
      return res.status(200).json({
        success: true,
        connected,
        telegramChatId: course.telegram_chat_id || '',
        telegramChatTitle: course.telegram_chat_title || '',
        telegramBot,
        approvedOrders: Number(approvedOrders || 0),
        pending: Boolean(course.telegram_connect_expires_at && new Date(course.telegram_connect_expires_at).getTime() > Date.now())
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const bot = await telegramApi('getMe');
    if (!bot?.username) throw new Error('Bot Telegram chưa có username');
    const token = await createCourseConnectToken(course.id);
    const connectUrl = `https://t.me/${encodeURIComponent(bot.username)}?start=${encodeURIComponent(token)}`;

    return res.status(200).json({
      success: true,
      connected: Boolean(String(course.telegram_chat_id || '').trim()),
      telegramChatId: course.telegram_chat_id || '',
      telegramChatTitle: course.telegram_chat_title || '',
      botUsername: bot.username,
      connectUrl
    });
  } catch (error) {
    console.error('TELEGRAM_CONNECT_API_ERROR:', error);
    return res.status(502).json({ error: error.message || String(error) });
  }
}
