import crypto from 'crypto';
import { telegramApi, telegramBotAdminRights, telegramConfigStatus, getTelegramRuntimeConfig } from '../utils/telegram.js';

function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return false;
  const x = Buffer.from(left, 'utf8');
  const y = Buffer.from(right, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!safeEqual(req.headers['x-admin-password'], process.env.ADMIN_PASSWORD)) return res.status(401).json({ error: 'Unauthorized' });
  const cfg = await telegramConfigStatus();
  if (!cfg.botToken || !cfg.webhookSecret || !cfg.adminChatId || cfg.adminUserIds.length === 0) {
    return res.status(409).json({ error: 'Thiếu cấu hình Telegram runtime', config: cfg });
  }
  try {
    const runtime = await getTelegramRuntimeConfig();
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = String(req.headers.host || '').trim();
    const webhookBaseUrl = proto + '://' + host + '/api/telegram-webhook';
    const isPreview = String(process.env.VERCEL_ENV || '').trim() === 'preview';
    const protectionBypass = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
    if (isPreview && !protectionBypass) {
      throw new Error('Preview đang bật Deployment Protection nhưng chưa có automation bypass secret');
    }
    const webhookUrl = isPreview
      ? webhookBaseUrl + '?x-vercel-protection-bypass=' + encodeURIComponent(protectionBypass)
      : webhookBaseUrl;
    const bot = await telegramApi('getMe');
    const rights = telegramBotAdminRights();

    await telegramApi('setMyDefaultAdministratorRights', { rights, for_channels: false });
    await telegramApi('setMyDefaultAdministratorRights', { rights, for_channels: true });

    const webhook = await telegramApi('setWebhook', {
      url: webhookUrl,
      secret_token: runtime.webhookSecret,
      allowed_updates: ['message', 'chat_join_request', 'callback_query'],
      drop_pending_updates: false
    });
    return res.status(200).json({
      success: true,
      bot: { id: bot.id, username: bot.username },
      webhookUrl: webhookBaseUrl,
      previewProtectionBypass: isPreview,
      webhook,
      allowedUpdates: ['message', 'chat_join_request', 'callback_query']
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || String(error) });
  }
}
