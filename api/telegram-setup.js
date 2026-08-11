import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { supabase } from '../utils/supabase.js';
import { telegramApi, telegramBotAdminRights, telegramConfigStatus, getTelegramRuntimeConfig } from '../utils/telegram.js';

const TEST_ORDER_ID = 'd48d3c00-b07b-4938-a075-306ba5606577';
const TEST_COURSE_ID = 'b1480de2-f4e9-4214-acd0-02d43a842076';
const TEST_PREFIX = '__clone_factory_test';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cloudinaryPublicIdFromUrl(value) {
  const url = new URL(String(value || ''));
  const marker = '/upload/';
  const idx = url.pathname.indexOf(marker);
  if (idx < 0) return '';
  let path = url.pathname.slice(idx + marker.length);
  path = path.replace(/^v\d+\//, '');
  return path.replace(/\.[A-Za-z0-9]+$/, '');
}

async function cleanupExactE2E() {
  const { data: order, error: orderError } = await supabase.from('orders').select('*').eq('id', TEST_ORDER_ID).maybeSingle();
  if (orderError) throw orderError;
  if (!order) return { success: true, alreadyCleaned: true };
  if (!String(order.customer_email || '').startsWith(TEST_PREFIX) || !String(order.course_slug || '').startsWith(TEST_PREFIX)) {
    throw new Error('Refusing cleanup: target is not prefixed test data');
  }

  let inviteRevoked = false;
  if (order.telegram_chat_id && order.telegram_invite_link) {
    try {
      await telegramApi('revokeChatInviteLink', {
        chat_id: String(order.telegram_chat_id),
        invite_link: String(order.telegram_invite_link)
      });
      inviteRevoked = true;
    } catch (error) {
      const msg = String(error.message || error);
      if (!/expired|revoked|not found|invite_hash/i.test(msg)) throw error;
    }
  }

  let billRemoved = false;
  const publicId = cloudinaryPublicIdFromUrl(order.proof_image_url);
  if (publicId) {
    const missing = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].filter(k => !process.env[k]);
    if (missing.length) throw new Error('Missing Cloudinary runtime config');
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
    if (!['ok', 'not found'].includes(String(result.result))) throw new Error('Cloudinary destroy failed: ' + result.result);
    billRemoved = true;
  }

  const { error: deleteOrderError } = await supabase.from('orders').delete().eq('id', TEST_ORDER_ID);
  if (deleteOrderError) throw deleteOrderError;

  const { data: course, error: courseError } = await supabase.from('courses').select('id,slug').eq('id', TEST_COURSE_ID).maybeSingle();
  if (courseError) throw courseError;
  if (course) {
    if (!String(course.slug || '').startsWith(TEST_PREFIX)) throw new Error('Refusing course cleanup: not test-prefixed');
    const { error: deleteCourseError } = await supabase.from('courses').delete().eq('id', TEST_COURSE_ID);
    if (deleteCourseError) throw deleteCourseError;
  }

  return { success: true, inviteRevoked, billRemoved, orderDeleted: true, courseDeleted: Boolean(course) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (String(req.query?.e2e_cleanup || '') === '1') {
    if (String(process.env.VERCEL_ENV || '').trim() === 'production') return res.status(403).json({ error: 'Preview only' });
    try {
      return res.status(200).json(await cleanupExactE2E());
    } catch (error) {
      console.error('E2E_TELEGRAM_CLEANUP_ERROR:', error);
      return res.status(500).json({ error: error.message || String(error) });
    }
  }

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
