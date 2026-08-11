import crypto from 'crypto';
import { telegramApi, telegramConfigStatus } from '../utils/telegram.js';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!safeEqual(req.headers['x-admin-password'], process.env.ADMIN_PASSWORD)) return res.status(401).json({ error: 'Unauthorized' });
  const cfg = telegramConfigStatus();
  if (!cfg.botToken || !cfg.webhookSecret || !cfg.adminChatId || cfg.adminUserIds.length === 0) {
    return res.status(409).json({ error: 'Thiếu TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ADMIN_CHAT_ID hoặc TELEGRAM_ADMIN_USER_IDS', config: cfg });
  }
  try {
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = String(req.headers.host || '').trim();
    const webhookUrl = proto + '://' + host + '/api/telegram-webhook';
    const bot = await telegramApi('getMe');
    const webhook = await telegramApi('setWebhook', { url: webhookUrl, secret_token: String(process.env.TELEGRAM_WEBHOOK_SECRET).trim(), allowed_updates: ['chat_join_request', 'callback_query'], drop_pending_updates: false });
    return res.status(200).json({ success: true, bot: { id: bot.id, username: bot.username }, webhookUrl, webhook });
  } catch (error) {
    return res.status(502).json({ error: error.message || String(error) });
  }
}
