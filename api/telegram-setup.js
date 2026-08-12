import { telegramApi, telegramBotAdminRights, telegramConfigStatus, getTelegramRuntimeConfig } from '../utils/telegram.js';

const CANONICAL_WEBHOOK = 'https://yeunauan-commerce-clone.vercel.app/api/telegram-webhook';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (String(process.env.VERCEL_ENV || '').trim() === 'production') {
    return res.status(403).json({ error: 'Preview-only operational endpoint' });
  }

  const cfg = await telegramConfigStatus();
  if (!cfg.botToken || !cfg.webhookSecret || !cfg.adminChatId || cfg.adminUserIds.length === 0) {
    return res.status(409).json({ error: 'Thiếu cấu hình Telegram runtime', config: cfg });
  }

  try {
    const runtime = await getTelegramRuntimeConfig();
    const bot = await telegramApi('getMe');
    const rights = telegramBotAdminRights();

    await telegramApi('setMyDefaultAdministratorRights', { rights, for_channels: false });
    await telegramApi('setMyDefaultAdministratorRights', { rights, for_channels: true });

    const webhook = await telegramApi('setWebhook', {
      url: CANONICAL_WEBHOOK,
      secret_token: runtime.webhookSecret,
      allowed_updates: ['message', 'chat_join_request', 'callback_query'],
      drop_pending_updates: false
    });
    const info = await telegramApi('getWebhookInfo');

    return res.status(200).json({
      success: true,
      bot: { id: bot.id, username: bot.username },
      webhook,
      webhookInfo: {
        url: info?.url || '',
        pendingUpdateCount: Number(info?.pending_update_count || 0),
        allowedUpdates: info?.allowed_updates || []
      }
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || String(error) });
  }
}
