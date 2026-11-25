import crypto from 'crypto';
import { supabase } from './supabase.js';

let cachedDbConfig = null;
let cachedDbConfigAt = 0;
const CONFIG_CACHE_MS = 30 * 1000;

function normalizeAdminIds(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

async function loadDbRuntimeConfig() {
  if (cachedDbConfig && Date.now() - cachedDbConfigAt < CONFIG_CACHE_MS) return cachedDbConfig;
  const { data, error } = await supabase
    .from('site_config')
    .select('value')
    .eq('key', 'telegram_runtime')
    .maybeSingle();
  if (error) throw error;
  cachedDbConfig = data?.value && typeof data.value === 'object' ? data.value : {};
  cachedDbConfigAt = Date.now();
  return cachedDbConfig;
}

export async function getTelegramRuntimeConfig() {
  const db = await loadDbRuntimeConfig().catch(error => {
    console.warn('TELEGRAM_RUNTIME_CONFIG_DB_ERROR:', error.message || error);
    return {};
  });
  return {
    botToken: String(process.env.TELEGRAM_BOT_TOKEN || db.botToken || '').trim(),
    webhookSecret: String(process.env.TELEGRAM_WEBHOOK_SECRET || db.webhookSecret || '').trim(),
    adminChatId: String(process.env.TELEGRAM_ADMIN_CHAT_ID || db.adminChatId || '').trim(),
    adminUserIds: normalizeAdminIds(process.env.TELEGRAM_ADMIN_USER_IDS || db.adminUserIds || [])
  };
}

export async function getTelegramWebhookSecret() {
  const cfg = await getTelegramRuntimeConfig();
  if (!cfg.webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET chưa được cấu hình');
  return cfg.webhookSecret;
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
  const cfg = await getTelegramRuntimeConfig();
  if (!cfg.botToken) throw new Error('TELEGRAM_BOT_TOKEN chưa được cấu hình');
  const response = await fetch(`https://api.telegram.org/bot${cfg.botToken}/${method}`, {
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

export async function telegramConfigStatus() {
  const cfg = await getTelegramRuntimeConfig();
  return {
    botToken: Boolean(cfg.botToken),
    webhookSecret: Boolean(cfg.webhookSecret),
    adminChatId: Boolean(cfg.adminChatId),
    adminUserIds: cfg.adminUserIds
  };
}

export async function isAllowedTelegramAdmin(userId) {
  const cfg = await getTelegramRuntimeConfig();
  return cfg.adminUserIds.length > 0 && cfg.adminUserIds.includes(String(userId));
}

export async function createCourseConnectToken(courseId) {
  const compact = compactUuid(courseId);
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new Error('Course ID không hợp lệ để tạo Telegram connect token');
  const secret = await getTelegramWebhookSecret();
  const signature = crypto.createHmac('sha256', secret).update(compact).digest('base64url').slice(0, 16);
  return `c_${compact}_${signature}`;
}

export async function verifyCourseConnectToken(token) {
  const match = /^c_([0-9a-f]{32})_([A-Za-z0-9_-]{16})$/.exec(String(token || '').trim());
  if (!match) return null;
  const secret = await getTelegramWebhookSecret();
  const expected = crypto.createHmac('sha256', secret).update(match[1]).digest('base64url').slice(0, 16);
  if (!safeEqual(match[2], expected)) return null;
  return expandUuid(match[1]);
}

// Groups and channels: ask for "ban users" so a revoked student is removed by the bot (channel verified on
// staging 25/11). restrict:false is the fallback picker when Telegram refuses that right.
export function telegramBotAdminRights({ restrict = true } = {}) {
  return {
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: false,
    can_manage_video_chats: false,
    // Channels too: banChatMember works in a channel when the bot has this right, so a revoke needs no manual removal.
    can_restrict_members: restrict,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: true,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false
  };
}

function telegramSelectingUserRights(opts) {
  return {
    ...telegramBotAdminRights(opts),
    can_promote_members: true
  };
}

export async function sendCourseChatPicker({ adminChatId, course, requestId }) {
  const baseRequestId = Number(requestId);
  if (!Number.isInteger(baseRequestId) || baseRequestId < 1 || baseRequestId > 2147483645) {
    throw new Error('Telegram request_id không hợp lệ');
  }

  const requestCommon = { request_title: true, request_username: true };
  const rightsFor = restrict => ({
    user_administrator_rights: telegramSelectingUserRights({ restrict }),
    bot_administrator_rights: telegramBotAdminRights({ restrict })
  });

  const send = channelRestrict => telegramApi('sendMessage', {
    chat_id: String(adminChatId),
    text: `🔗 KẾT NỐI KHÓA HỌC TELEGRAM\n\nKhóa: ${course.title || course.slug}\n\nChọn đúng nhóm hoặc kênh chứa nội dung khóa học. Telegram sẽ cấp cho bot quyền cần thiết để tạo link xin gia nhập và duyệt học viên.`,
    reply_markup: {
      keyboard: [
        [{
          text: '👥 Chọn nhóm / supergroup',
          request_chat: {
            request_id: baseRequestId,
            chat_is_channel: false,
            ...rightsFor(true),
            ...requestCommon
          }
        }],
        [{
          text: '📣 Chọn kênh / channel',
          request_chat: {
            request_id: baseRequestId + 1,
            chat_is_channel: true,
            ...rightsFor(channelRestrict),
            ...requestCommon
          }
        }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
      input_field_placeholder: 'Chọn group/channel cần kết nối'
    }
  });
  try {
    return await send(true);
  } catch (error) {
    // shortcut: unverified that Telegram accepts the ban right in a channel picker; if it refuses, fall back to the old rights (manual removal on revoke).
    console.error('TELEGRAM_PICKER_CHANNEL_RESTRICT_REFUSED:', error.message || error);
    return send(false);
  }
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
  const canRestrict = member?.status === 'creator' || member?.can_restrict_members === true;
  return { ok: Boolean(isAdmin && canInvite), canRestrict: Boolean(isAdmin && canRestrict), bot, member };
}

// What the Admin page shows about the bot in a course's group/channel (kept in courses.raw_data.telegramBot).
export function telegramBotSnapshot(permission, chatType) {
  return {
    canInvite: Boolean(permission?.ok),
    canRestrict: Boolean(permission?.canRestrict),
    status: permission?.member?.status || 'unknown',
    ...(chatType ? { chatType } : {}),
    checkedAt: new Date().toISOString()
  };
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

export async function revokeTelegramInvite(chatId, inviteLink) {
  if (!chatId || !inviteLink) return null;
  return telegramApi('revokeChatInviteLink', { chat_id: String(chatId), invite_link: String(inviteLink) });
}

export async function approveTelegramJoin(chatId, userId) {
  return telegramApi('approveChatJoinRequest', { chat_id: String(chatId), user_id: Number(userId) });
}

export async function declineTelegramJoin(chatId, userId) {
  return telegramApi('declineChatJoinRequest', { chat_id: String(chatId), user_id: Number(userId) });
}

// 'member' | 'administrator' | 'creator' | 'restricted' | 'left' | 'kicked', or null when Telegram cannot tell.
export async function getTelegramMemberStatus(chatId, userId) {
  try {
    const member = await telegramApi('getChatMember', { chat_id: String(chatId), user_id: Number(userId) });
    return member?.status || null;
  } catch {
    return null;
  }
}

export async function unbanTelegramMember(chatId, userId) {
  return telegramApi('unbanChatMember', { chat_id: String(chatId), user_id: Number(userId), only_if_banned: true });
}

// Removes a member and lifts the ban at once, so a later paid order can invite them again.
export async function removeTelegramMember(chatId, userId) {
  await telegramApi('banChatMember', { chat_id: String(chatId), user_id: Number(userId), revoke_messages: false });
  return unbanTelegramMember(chatId, userId);
}

export async function answerTelegramCallback(callbackQueryId, text, showAlert = false) {
  return telegramApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text: String(text || '').slice(0, 200), show_alert: Boolean(showAlert) });
}

// Final label for a decided order, or null while it still waits. Revoke marks the order rejected with join status 'revoked'.
export function telegramDecisionLabel(order) {
  if (order?.status === 'Đã duyệt') return '✅ ĐÃ DUYỆT THÀNH CÔNG';
  if (order?.status === 'Từ chối') return order.telegram_join_status === 'revoked' ? '⛔ ĐÃ THU HỒI QUYỀN' : '❌ ĐÃ TỪ CHỐI';
  return null;
}

// Replaces DUYỆT/TỪ CHỐI on the Admin's notice with one display-only button (tgdone: never acts). Message text stays.
export async function markTelegramDecision(message, order) {
  const label = telegramDecisionLabel(order);
  if (!label || !message?.chat?.id || !message.message_id) return false;
  await telegramApi('editMessageReplyMarkup', {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reply_markup: { inline_keyboard: [[{ text: label, callback_data: `tgdone:${order.id}` }]] }
  });
  return true;
}

export async function notifyAdminJoinRequest(order, from) {
  const cfg = await getTelegramRuntimeConfig();
  if (!cfg.adminChatId) throw new Error('TELEGRAM_ADMIN_CHAT_ID chưa được cấu hình');
  const username = from?.username ? '@' + from.username : '(không có username)';
  const lines = [
    '📥 YÊU CẦU VÀO KHÓA TELEGRAM',
    '',
    `Khóa: ${order.course_title || order.course_slug}`,
    `Nick Telegram khách khai báo: ${order.telegram_claimed_username || '(không có)'}`,
    `Telegram thực tế: ${from?.first_name || ''} ${username}`,
    `Order: ${order.id}`,
    `Bill: ${order.proof_image_url || '(không có)'}`,
    ...(order.duplicateApprovedOrderId ? ['', `⚠️ Telegram này đã có đơn ĐÃ DUYỆT cho khóa này: ${order.duplicateApprovedOrderId}. Kiểm tra trước khi duyệt thêm.`] : []),
    '',
    'Kiểm tra bill + sao kê trước khi bấm DUYỆT. Nick khai báo phải khớp Telegram thực tế.'
  ];
  return telegramApi('sendMessage', {
    chat_id: cfg.adminChatId,
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
