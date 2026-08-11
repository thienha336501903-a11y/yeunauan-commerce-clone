import crypto from 'crypto';

function getBotToken() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN chưa được cấu hình');
  return token;
}

function getConnectSecret() {
  const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET chưa được cấu hình');
  return secret;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function compactUuid(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '');
}

function expandUuid(compact) {
  if (!/^[0-9a-f]{32}$/.test(compact)) return null;
  return [compact.slice(0, 8), compact.slice(8, 12), compact.slice(12, 16), compact.slice(16, 20), compact.slice(20)].join('-');
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

export function createCourseConnectToken(courseId) {
  const compact = compactUuid(courseId);
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new Error('Course ID không hợp lệ để tạo Telegram connect token');
  const signature = crypto.createHmac('sha256', getConnectSecret()).update(compact).digest('base64url').slice(0, 16);
  return `c_${compact}_${signature}`;
}

export function verifyCourseConnectToken(token) {
  const match = /^c_([0-9a-f]{32})_([A-Za-z0-9_-]{16})$/.exec(String(token || '').trim());
  if (!match) return null;
  const expected = crypto.createHmac('sha256', getConnectSecret()).update(match[1]).digest('base64url').slice(0, 16);
  if (!safeEqual(match[2], expected)) return null;
  return expandUuid(match[1]);
}

export function telegramBotAdminRights() {
  return {
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: false,
    can_manage_video_chats: false,
    can_restrict_members: false,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: true,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false
  };
}

function telegramSelectingUserRights() {
  return {
    ...telegramBotAdminRights(),
    can_promote_members: true
  };
}

export async function sendCourseChatPicker({ adminChatId, course, requestId }) {
  const baseRequestId = Number(requestId);
  if (!Number.isInteger(baseRequestId) || baseRequestId < 1 || baseRequestId > 2147483645) {
    throw new Error('Telegram request_id không hợp lệ');
  }

  const botRights = telegramBotAdminRights();
  const userRights = telegramSelectingUserRights();
  const requestCommon = {
    user_administrator_rights: userRights,
    bot_administrator_rights: botRights,
    request_title: true,
    request_username: true
  };

  return telegramApi('sendMessage', {
    chat_id: String(adminChatId),
    text: `🔗 KẾT NỐI KHÓA HỌC TELEGRAM\n\nKhóa: ${course.title || course.slug}\n\nChọn đúng nhóm hoặc kênh chứa nội dung khóa học. Telegram sẽ cấp cho bot quyền cần thiết để tạo link xin gia nhập và duyệt học viên.`,
    reply_markup: {
      keyboard: [
        [{
          text: '👥 Chọn nhóm / supergroup',
          request_chat: {
            request_id: baseRequestId,
            chat_is_channel: false,
            ...requestCommon
          }
        }],
        [{
          text: '📣 Chọn kênh / channel',
          request_chat: {
            request_id: baseRequestId + 1,
            chat_is_channel: true,
            ...requestCommon
          }
        }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
      input_field_placeholder: 'Chọn group/channel cần kết nối'
    }
  });
}

export async function sendTelegramPrivateMessage(chatId, text, removeKeyboard = false) {
  return telegramApi('sendMessage', {
    chat_id: String(chatId),
    text,
    ...(removeKeyboard ? { reply_markup: { remove_keyboard: true } } : {})
  });
}

export async function verifyBotInvitePermission(chatId) {
  const bot = await telegramApi('getMe');
  const member = await telegramApi('getChatMember', { chat_id: String(chatId), user_id: bot.id });
  const isAdmin = member?.status === 'administrator' || member?.status === 'creator';
  const canInvite = member?.status === 'creator' || member?.can_invite_users === true;
  return { ok: Boolean(isAdmin && canInvite), bot, member };
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
