function getBotToken() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN chưa được cấu hình');
  return token;
}

export async function telegramApi(method, payload = {}) {
  const token = getBotToken();
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const description = data.description || `Telegram API ${method} failed (HTTP ${response.status})`;
    throw new Error(description);
  }
  return data.result;
}

export function telegramConfigStatus() {
  return {
    botToken: Boolean(String(process.env.TELEGRAM_BOT_TOKEN || '').trim()),
    webhookSecret: Boolean(String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim()),
    adminChatId: Boolean(String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim()),
    adminUserIds: String(process.env.TELEGRAM_ADMIN_USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean)
  };
}

export function isAllowedTelegramAdmin(userId) {
  const ids = String(process.env.TELEGRAM_ADMIN_USER_IDS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  return ids.length > 0 && ids.includes(String(userId));
}

export async function createOrderInvite({ chatId, orderId, courseSlug, ttlHours = 72 }) {
  const ttl = Math.min(720, Math.max(1, Number.parseInt(ttlHours, 10) || 72));
  const expireUnix = Math.floor(Date.now() / 1000) + ttl * 3600;
  const name = `order:${String(orderId).slice(0, 8)}:${String(courseSlug).slice(0, 14)}`.slice(0, 32);
  const result = await telegramApi('createChatInviteLink', {
    chat_id: String(chatId),
    name,
    expire_date: expireUnix,
    creates_join_request: true
  });
  return {
    inviteLink: result.invite_link,
    inviteName: result.name || name,
    expiresAt: new Date(expireUnix * 1000).toISOString()
  };
}

export async function approveTelegramJoin(chatId, userId) {
  return telegramApi('approveChatJoinRequest', { chat_id: String(chatId), user_id: Number(userId) });
}

export async function declineTelegramJoin(chatId, userId) {
  return telegramApi('declineChatJoinRequest', { chat_id: String(chatId), user_id: Number(userId) });
}

export async function answerTelegramCallback(callbackQueryId, text) {
  return telegramApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: false });
}

export async function notifyAdminJoinRequest(order, from) {
  const adminChatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  if (!adminChatId) return null;
  const username = from?.username ? '@' + from.username : '(không có username)';
  const lines = [
    '📥 YÊU CẦU VÀO KHÓA TELEGRAM',
    '',
    `Khóa: ${order.course_title || order.course_slug}`,
    `Email: ${order.customer_email}`,
    `Telegram: ${from?.first_name || ''} ${username}`,
    `Order: ${order.id}`,
    `Bill: ${order.proof_image_url || '(không có)'}`
  ];
  return telegramApi('sendMessage', {
    chat_id: adminChatId,
    text: lines.join('\n'),
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ DUYỆT', callback_data: `tgapprove:${order.id}` },
        { text: '❌ TỪ CHỐI', callback_data: `tgdecline:${order.id}` }
      ]]
    }
  });
}
