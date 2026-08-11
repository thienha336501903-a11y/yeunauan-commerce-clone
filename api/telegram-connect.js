import crypto from 'crypto';
import { supabase } from '../utils/supabase.js';
import { createCourseConnectToken, telegramApi } from '../utils/telegram.js';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function getCourse(courseId) {
  const { data, error } = await supabase
    .from('courses')
    .select('id, slug, title, delivery_mode, telegram_chat_id, telegram_chat_title, telegram_connect_expires_at')
    .eq('id', courseId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export default async function handler(req, res) {
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
      return res.status(200).json({
        success: true,
        connected: Boolean(String(course.telegram_chat_id || '').trim()),
        telegramChatId: course.telegram_chat_id || '',
        telegramChatTitle: course.telegram_chat_title || '',
        pending: Boolean(course.telegram_connect_expires_at && new Date(course.telegram_connect_expires_at).getTime() > Date.now())
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const bot = await telegramApi('getMe');
    if (!bot?.username) throw new Error('Bot Telegram chưa có username');
    const token = createCourseConnectToken(course.id);
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
