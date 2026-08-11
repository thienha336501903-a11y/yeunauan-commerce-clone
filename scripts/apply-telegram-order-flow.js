import fs from 'node:fs';

function write(path, content) {
  fs.mkdirSync(path.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  fs.writeFileSync(path, content.trimStart(), 'utf8');
}

function patch(path, fn) {
  const before = fs.readFileSync(path, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`No changes applied to ${path}`);
  fs.writeFileSync(path, after, 'utf8');
}

function mustReplace(text, oldValue, newValue, label) {
  if (!text.includes(oldValue)) throw new Error(`Missing marker: ${label}`);
  return text.replace(oldValue, newValue);
}

write('utils/telegram.js', `
function getBotToken() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN chưa được cấu hình');
  return token;
}

export async function telegramApi(method, payload = {}) {
  const token = getBotToken();
  const response = await fetch(\`https://api.telegram.org/bot\${token}/\${method}\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const description = data.description || \`Telegram API \${method} failed (HTTP \${response.status})\`;
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
  const name = \`order:\${String(orderId).slice(0, 8)}:\${String(courseSlug).slice(0, 14)}\`.slice(0, 32);
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
    \`Khóa: \${order.course_title || order.course_slug}\`,
    \`Email: \${order.customer_email}\`,
    \`Telegram: \${from?.first_name || ''} \${username}\`,
    \`Order: \${order.id}\`,
    \`Bill: \${order.proof_image_url || '(không có)'}\`
  ];
  return telegramApi('sendMessage', {
    chat_id: adminChatId,
    text: lines.join('\\n'),
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ DUYỆT', callback_data: \`tgapprove:\${order.id}\` },
        { text: '❌ TỪ CHỐI', callback_data: \`tgdecline:\${order.id}\` }
      ]]
    }
  });
}
`);

write('api/config.js', `
import { supabase } from '../utils/supabase.js';

export default async function handler(req, res) {
  try {
    const courseSlug = req.query.course || 'banhmi4k';
    const { data: course, error } = await supabase
      .from('courses')
      .select('*')
      .eq('slug', courseSlug)
      .eq('active', true)
      .single();

    if (error || !course) {
      return res.status(404).json({ error: \`Không tìm thấy khóa học hoạt động với slug: \${courseSlug}\` });
    }

    const rawData = course.raw_data || {};
    const courseImage = course.image_url || rawData.imageUrl || rawData.posterUrl || rawData.posterImageUrl || rawData.thumbnail || rawData.heroUrl || rawData.heroImageUrl || rawData.coverUrl || '';

    return res.status(200).json({
      course: course.slug,
      courseName: course.title,
      price: course.price || '',
      imageUrl: courseImage,
      bankName: rawData.bankName || '',
      bankAccount: rawData.bankAccount || '',
      bankOwner: rawData.bankOwner || '',
      transferNote: rawData.transferNote || '',
      qrImageUrl: rawData.qrImageUrl || '',
      deliveryMode: course.delivery_mode === 'telegram' ? 'telegram' : 'lms'
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
`);

write('api/register.js', `
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { supabase } from '../utils/supabase.js';
import { createOrderInvite } from '../utils/telegram.js';

const MAX_BILL_BYTES = 5 * 1024 * 1024;
const ALLOWED_BILL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DEFAULT_COURSE_SLUG = 'banhmi4k';
const normalizeEmail = email => String(email || '').trim().toLowerCase();
const isValidEmail = email => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) && !/[^\\x00-\\x7F]/.test(email);
const normalizeBase64 = value => String(value || '').replace(/\\s+/g, '');
const isValidBase64 = value => value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { gmail, billName, billType, billData, course } = req.body || {};
    const cleanEmail = normalizeEmail(gmail);
    const cleanBillType = String(billType || '').trim().toLowerCase();
    const cleanBillData = normalizeBase64(billData);
    const courseSlug = String(course || DEFAULT_COURSE_SLUG).trim().toLowerCase();

    if (!cleanEmail || !billName || !cleanBillType || !cleanBillData) return res.status(400).json({ error: 'Thiếu dữ liệu' });
    if (!isValidEmail(cleanEmail)) return res.status(400).json({ error: 'Địa chỉ email không hợp lệ' });
    if (!ALLOWED_BILL_TYPES.has(cleanBillType)) return res.status(400).json({ error: 'Chỉ nhận file JPG, PNG hoặc WEBP' });
    if (!isValidBase64(cleanBillData)) return res.status(400).json({ error: 'Dữ liệu ảnh bill không hợp lệ' });
    const billBytes = Buffer.byteLength(cleanBillData, 'base64');
    if (!billBytes) return res.status(400).json({ error: 'Ảnh bill trống' });
    if (billBytes > MAX_BILL_BYTES) return res.status(413).json({ error: 'Ảnh bill quá lớn. Vui lòng chọn ảnh dưới 5MB' });
    if (!/^[a-z0-9_-]+$/.test(courseSlug)) return res.status(400).json({ error: 'Mã khóa học không hợp lệ' });

    const { data: courseRec, error: courseError } = await supabase
      .from('courses')
      .select('id, image_url, title, active, delivery_mode, telegram_chat_id, telegram_invite_ttl_hours')
      .eq('slug', courseSlug)
      .maybeSingle();
    if (courseError) throw courseError;
    if (!courseRec || courseRec.active === false) return res.status(404).json({ error: 'Khóa học không tồn tại hoặc chưa mở đăng ký' });

    const missingCloudinaryEnv = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].filter(name => !process.env[name]);
    if (missingCloudinaryEnv.length) return res.status(500).json({ error: 'Hệ thống upload bill chưa được cấu hình đầy đủ' });

    cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
    const uploadResult = await cloudinary.uploader.upload('data:' + cleanBillType + ';base64,' + cleanBillData, { folder: 'bill-chuyen-khoan/' + courseSlug, resource_type: 'image' });
    const billLink = uploadResult.secure_url;
    const finalCourseName = courseRec.title || courseSlug;
    const thumbnail = courseRec.image_url || '';
    const orderId = crypto.randomUUID();
    const deliveryMode = courseRec.delivery_mode === 'telegram' ? 'telegram' : 'lms';

    const orderPayload = {
      id: orderId,
      course_id: courseRec.id,
      course_slug: courseSlug,
      course_title: finalCourseName,
      customer_email: cleanEmail,
      proof_image_url: billLink,
      status: 'Chờ duyệt',
      delivery_mode: deliveryMode,
      telegram_chat_id: deliveryMode === 'telegram' ? String(courseRec.telegram_chat_id || '').trim() || null : null,
      raw_data: { billName: String(billName).slice(0, 120), billType: cleanBillType }
    };

    if (deliveryMode === 'telegram') {
      if (!orderPayload.telegram_chat_id) return res.status(409).json({ error: 'Khóa học Telegram chưa cấu hình Chat ID' });
      orderPayload.sync_lms_status = 'SKIPPED_TELEGRAM';
      orderPayload.sync_portal_status = 'SKIPPED_TELEGRAM';
      orderPayload.telegram_join_status = 'invite_creating';
    }

    const { error: insertError } = await supabase.from('orders').insert(orderPayload);
    if (insertError) throw insertError;

    if (deliveryMode === 'telegram') {
      try {
        const invite = await createOrderInvite({ chatId: orderPayload.telegram_chat_id, orderId, courseSlug, ttlHours: courseRec.telegram_invite_ttl_hours || 72 });
        const { error: inviteUpdateError } = await supabase.from('orders').update({
          telegram_invite_link: invite.inviteLink,
          telegram_invite_name: invite.inviteName,
          telegram_invite_expires_at: invite.expiresAt,
          telegram_join_status: 'invite_ready',
          sync_error: null,
          updated_at: new Date().toISOString()
        }).eq('id', orderId);
        if (inviteUpdateError) throw inviteUpdateError;
        return res.status(200).json({ success: true, file: billLink, course: courseSlug, courseName: finalCourseName, orderId, deliveryMode: 'telegram', telegramInviteLink: invite.inviteLink, telegramInviteExpiresAt: invite.expiresAt });
      } catch (telegramError) {
        console.error('TELEGRAM_INVITE_ERROR:', telegramError);
        await supabase.from('orders').update({ telegram_join_status: 'invite_error', sync_error: String(telegramError.message || telegramError).slice(0, 500), updated_at: new Date().toISOString() }).eq('id', orderId);
        return res.status(200).json({ success: true, file: billLink, course: courseSlug, courseName: finalCourseName, orderId, deliveryMode: 'telegram', telegramReady: false, message: 'Đã nhận bill nhưng chưa tạo được link Telegram. Admin sẽ xử lý đơn này.' });
      }
    }

    const system1Url = process.env.SYSTEM1_URL;
    const syncSecret = process.env.INTERNAL_SYNC_SECRET;
    if (system1Url && syncSecret) {
      try {
        await fetch(\`${system1Url.trim().replace(/\\/$/, '')}/api/sync\`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': syncSecret }, body: JSON.stringify({ action: 'syncPendingOrder', email: cleanEmail, courseSlug, courseName: finalCourseName, thumbnail }) });
      } catch (syncErr) { console.error('Error syncing pending order to Portal:', syncErr); }
    }
    return res.status(200).json({ success: true, file: billLink, course: courseSlug, courseName: finalCourseName, orderId, deliveryMode: 'lms' });
  } catch (error) {
    console.error('REGISTER_ERROR:', error);
    return res.status(500).json({ error: 'Không thể ghi nhận đăng ký. Vui lòng thử lại' });
  }
}
`);

write('api/orders.js', `
import { supabase } from '../utils/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const adminPassword = req.headers['x-admin-password'];
  const systemPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword || adminPassword !== systemPassword) return res.status(401).json({ error: 'Unauthorized: Mật khẩu Admin không chính xác hoặc trống.' });

  try {
    if (req.method === 'GET') {
      const { data: orders, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json(orders.map(o => {
        const timeFormatted = o.created_at ? new Date(o.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';
        return {
          id: o.id, created_at: o.created_at, 'Thời gian': timeFormatted, time: timeFormatted,
          'Course': o.course_slug, course: o.course_slug, 'Tên khóa học': o.course_title, courseName: o.course_title,
          'Gmail': o.customer_email, gmail: o.customer_email, 'Link bill': o.proof_image_url, billLink: o.proof_image_url,
          'Trạng thái': o.status, status: o.status, note: o.note || '', customer_phone: o.customer_phone || '', customer_name: o.customer_name || '',
          sync_lms_status: o.sync_lms_status || 'PENDING', sync_portal_status: o.sync_portal_status || 'PENDING', sync_error: o.sync_error || '',
          delivery_mode: o.delivery_mode || 'lms', telegram_chat_id: o.telegram_chat_id || '', telegram_invite_link: o.telegram_invite_link || '', telegram_invite_expires_at: o.telegram_invite_expires_at || '',
          telegram_user_id: o.telegram_user_id || null, telegram_username: o.telegram_username || '', telegram_first_name: o.telegram_first_name || '', telegram_join_status: o.telegram_join_status || '', telegram_join_requested_at: o.telegram_join_requested_at || '', telegram_join_decided_at: o.telegram_join_decided_at || '',
          ...(o.raw_data || {})
        };
      }));
    }

    if (req.method === 'PUT') {
      const { id, status, note, customer_name, customer_phone, gmail, action } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Thiếu ID đơn hàng để cập nhật' });

      if (action === 'resync') {
        const { data: order, error: fetchErr } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
        if (order.delivery_mode === 'telegram') return res.status(200).json({ success: true, data: { ...order, syncResults: { lms: 'SKIPPED_TELEGRAM', portal: 'SKIPPED_TELEGRAM', error: null } } });
        const { syncEnrollmentToExternalSystems } = await import('../utils/sync-helpers.js');
        const actionType = order.status === 'Đã duyệt' ? 'create' : 'revoke';
        const syncResults = await syncEnrollmentToExternalSystems(order, actionType);
        const { data: updatedOrder, error: updateErr } = await supabase.from('orders').update({ sync_lms_status: syncResults.lms, sync_portal_status: syncResults.portal, sync_error: syncResults.error }).eq('id', id).select().single();
        if (updateErr) throw updateErr;
        return res.status(200).json({ success: true, data: { ...updatedOrder, syncResults } });
      }

      const updateData = { updated_at: new Date().toISOString() };
      if (status !== undefined) updateData.status = status;
      if (note !== undefined) updateData.note = note;
      if (customer_name !== undefined) updateData.customer_name = customer_name;
      if (customer_phone !== undefined) updateData.customer_phone = customer_phone;
      if (gmail !== undefined) {
        const validatedGmail = validateGmail(gmail);
        if (!validatedGmail) return res.status(400).json({ error: 'Địa chỉ email không hợp lệ' });
        updateData.customer_email = validatedGmail;
      }

      const { data, error } = await supabase.from('orders').update(updateData).eq('id', id).select().single();
      if (error) throw error;

      let syncResults = null;
      let updatedData = { ...data };
      if (status !== undefined) {
        if (data.delivery_mode === 'telegram') {
          syncResults = { lms: 'SKIPPED_TELEGRAM', portal: 'SKIPPED_TELEGRAM', error: null };
          const { data: finalData } = await supabase.from('orders').update({ sync_lms_status: syncResults.lms, sync_portal_status: syncResults.portal, sync_error: null }).eq('id', id).select().single();
          if (finalData) updatedData = finalData;
        } else {
          try {
            const { syncEnrollmentToExternalSystems } = await import('../utils/sync-helpers.js');
            const actionType = status === 'Đã duyệt' ? 'create' : 'revoke';
            syncResults = await syncEnrollmentToExternalSystems(data, actionType);
            const { data: finalData } = await supabase.from('orders').update({ sync_lms_status: syncResults.lms, sync_portal_status: syncResults.portal, sync_error: syncResults.error }).eq('id', id).select().single();
            if (finalData) updatedData = finalData;
          } catch (syncErr) { console.error('Order sync trigger error:', syncErr); }
        }
      }
      return res.status(200).json({ success: true, data: { ...updatedData, syncResults } });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('ORDERS_API_ERROR:', error);
    return res.status(500).json({ error: error.message });
  }
}

function validateGmail(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(trimmed) || /\\s/.test(trimmed) || /[^\\x00-\\x7F]/.test(trimmed)) return null;
  return trimmed;
}
`);

write('api/courses.js', `
import { supabase } from '../utils/supabase.js';

const normalizeExpectedStartDate = value => /^\\d{4}-\\d{2}-\\d{2}$/.test(String(value || '').trim()) ? String(value).trim() : null;
const validDateInput = value => String(value || '').trim() === '' || /^\\d{4}-\\d{2}-\\d{2}$/.test(String(value || '').trim());
const mode = value => value === 'telegram' ? 'telegram' : 'lms';
const ttl = value => Math.min(720, Math.max(1, Number.parseInt(value, 10) || 72));

async function syncCourseIfLms(course, dataId) {
  if (mode(course.deliveryMode) === 'telegram') {
    const result = { lms: 'SKIPPED_TELEGRAM', portal: 'SKIPPED_TELEGRAM', error: null };
    await supabase.from('courses').update({ sync_lms_status: result.lms, sync_portal_status: result.portal, sync_error: null }).eq('id', dataId);
    return result;
  }
  const { syncCourseToExternalSystems } = await import('../utils/sync-helpers.js');
  const result = await syncCourseToExternalSystems({ slug: course.slug, courseName: course.courseName, price: course.price, imageUrl: course.imageUrl, expected_start_date: course.expected_start_date, active: course.active, teacher_name: course.teacher_name });
  await supabase.from('courses').update({ sync_lms_status: result.lms, sync_portal_status: result.portal, sync_error: result.error }).eq('id', dataId);
  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const adminPassword = req.headers['x-admin-password'];
  if (!adminPassword || adminPassword !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized: Mật khẩu Admin không chính xác hoặc trống.' });

  try {
    if (req.method === 'GET') {
      const { data: courses, error } = await supabase.from('courses').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json(courses.map(c => ({
        id: c.id, slug: c.slug, courseName: c.title, price: c.price || '', imageUrl: c.image_url || c.raw_data?.imageUrl || c.raw_data?.posterUrl || c.raw_data?.posterImageUrl || c.raw_data?.thumbnail || c.raw_data?.heroUrl || c.raw_data?.heroImageUrl || c.raw_data?.coverUrl || '',
        expected_start_date: c.expected_start_date || '', active: c.active, sort_order: c.sort_order, description: c.description || '', teacher_name: c.teacher_name || '', is_published: c.is_published === true, created_at: c.created_at,
        sync_lms_status: c.sync_lms_status || 'PENDING', sync_portal_status: c.sync_portal_status || 'PENDING', sync_error: c.sync_error || '',
        deliveryMode: mode(c.delivery_mode), telegramChatId: c.telegram_chat_id || '', telegramChatTitle: c.telegram_chat_title || '', telegramInviteTtlHours: c.telegram_invite_ttl_hours || 72,
        ...(c.raw_data || {})
      })));
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const body = req.body || {};
      const id = body.id;
      const slug = String(body.slug || '').trim();
      const courseName = String(body.courseName || body.title || '').trim();
      if (!slug || !courseName) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc (slug, title)' });
      if (!validDateInput(body.expected_start_date)) return res.status(400).json({ error: 'Lịch khai giảng dự kiến phải có định dạng YYYY-MM-DD' });
      const deliveryMode = mode(body.deliveryMode || body.delivery_mode);
      const telegramChatId = String(body.telegramChatId || body.telegram_chat_id || '').trim();
      if (deliveryMode === 'telegram' && !telegramChatId) return res.status(400).json({ error: 'Khóa Telegram bắt buộc phải có Telegram Chat/Channel ID' });

      const base = {
        slug, title: courseName, price: body.price, image_url: String(body.imageUrl || '').trim(), expected_start_date: normalizeExpectedStartDate(body.expected_start_date),
        active: body.active !== undefined ? body.active : true, sort_order: body.sort_order !== undefined ? Number.parseInt(body.sort_order, 10) || 0 : 0,
        description: body.description || '', teacher_name: body.teacher_name || '', delivery_mode: deliveryMode,
        telegram_chat_id: deliveryMode === 'telegram' ? telegramChatId : null,
        telegram_chat_title: deliveryMode === 'telegram' ? String(body.telegramChatTitle || body.telegram_chat_title || '').trim() || null : null,
        telegram_invite_ttl_hours: ttl(body.telegramInviteTtlHours || body.telegram_invite_ttl_hours),
        raw_data: { bankName: body.bankName || '', bankAccount: body.bankAccount || '', bankOwner: body.bankOwner || '', transferNote: body.transferNote || '', qrImageUrl: body.qrImageUrl || '' }
      };
      if (body.is_published !== undefined) base.is_published = body.is_published === true;

      let data;
      if (req.method === 'POST') {
        base.id = id || crypto.randomUUID();
        const result = await supabase.from('courses').insert(base).select().single();
        if (result.error) throw result.error;
        data = result.data;
      } else {
        if (!id) return res.status(400).json({ error: 'Thiếu ID khóa học để cập nhật' });
        const { data: existing, error: existingErr } = await supabase.from('courses').select('image_url, raw_data, expected_start_date').eq('id', id).maybeSingle();
        if (existingErr) throw existingErr;
        base.image_url = base.image_url || existing?.image_url || '';
        base.raw_data = { ...(existing?.raw_data || {}), ...base.raw_data };
        if (!Object.prototype.hasOwnProperty.call(body, 'expected_start_date')) delete base.expected_start_date;
        const result = await supabase.from('courses').update(base).eq('id', id).select().single();
        if (result.error) throw result.error;
        data = result.data;
      }

      let syncResults = { lms: 'PENDING', portal: 'PENDING', error: null };
      try { syncResults = await syncCourseIfLms({ ...body, slug, courseName, deliveryMode }, data.id); } catch (syncErr) { console.error('Course sync trigger error:', syncErr); syncResults.error = String(syncErr.message || syncErr); }
      return res.status(req.method === 'POST' ? 201 : 200).json({ success: true, data: { ...data, syncResults } });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || req.query;
      if (!id) return res.status(400).json({ error: 'Thiếu ID khóa học để xóa' });
      const { error } = await supabase.from('courses').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ success: true, message: 'Đã xóa khóa học thành công' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('COURSES_API_ERROR:', error);
    return res.status(500).json({ error: error.message });
  }
}
`);

write('api/telegram-webhook.js', `
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
`);

write('api/telegram-setup.js', `
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
    const webhookUrl = \`${proto}://${host}/api/telegram-webhook\`;
    const bot = await telegramApi('getMe');
    const webhook = await telegramApi('setWebhook', { url: webhookUrl, secret_token: String(process.env.TELEGRAM_WEBHOOK_SECRET).trim(), allowed_updates: ['chat_join_request', 'callback_query'], drop_pending_updates: false });
    return res.status(200).json({ success: true, bot: { id: bot.id, username: bot.username }, webhookUrl, webhook });
  } catch (error) {
    return res.status(502).json({ error: error.message || String(error) });
  }
}
`);

patch('index.html', text => {
  const old = `      if(response.ok){\n        console.log('[Checkout] register success', data);\n        console.log('[Checkout] redirecting to clone LMS portal');\n        const targetLmsUrl = (window.LMS_PUBLIC_URL || 'https://yeunauan-lms-clone.vercel.app').replace(/\\/$/, '');\n        window.location.href = targetLmsUrl;\n      }else{`;
  const next = `      if(response.ok){\n        console.log('[Checkout] register success', data);\n        if(data.deliveryMode==='telegram'){\n          setProgress(100, data.telegramInviteLink ? 'Đang mở Telegram...' : 'Đã ghi nhận bill.');\n          if(data.telegramInviteLink){\n            window.location.href=data.telegramInviteLink;\n          }else{\n            alert(data.message||'Đã nhận bill. Link Telegram đang được Admin xử lý.');\n            btn.disabled=false;\n            btn.innerText='GỬI ĐĂNG KÝ';\n          }\n        }else{\n          console.log('[Checkout] redirecting to clone LMS portal');\n          const targetLmsUrl = (window.LMS_PUBLIC_URL || 'https://yeunauan-lms-clone.vercel.app').replace(/\\/$/, '');\n          window.location.href = targetLmsUrl;\n        }\n      }else{`;
  return mustReplace(text, old, next, 'index register success block');
});

patch('admin.html', text => {
  let out = text;
  const marker = `        <!-- BANK PAYMENT SETTINGS SECTION -->`;
  const block = `        <!-- DELIVERY MODE -->\n        <div class="border-t border-slate-100 pt-6">\n          <h4 class="text-lg font-bold text-slate-900 mb-4">Hình thức học</h4>\n          <select id="courseDeliveryModeInput" onchange="toggleTelegramFields()" class="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-pink-500 transition text-sm">\n            <option value="lms">Học trên hệ thống LMS</option>\n            <option value="telegram">Học trên Telegram</option>\n          </select>\n          <div id="telegramCourseFields" class="hidden mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">\n            <div>\n              <label class="block text-xs uppercase font-extrabold text-slate-500 tracking-wider mb-2">Telegram Chat / Channel ID *</label>\n              <input type="text" id="telegramChatIdInput" placeholder="Ví dụ: -1001234567890" class="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-pink-500 transition text-sm font-mono">\n            </div>\n            <div>\n              <label class="block text-xs uppercase font-extrabold text-slate-500 tracking-wider mb-2">Tên nhóm/kênh Telegram</label>\n              <input type="text" id="telegramChatTitleInput" placeholder="Ví dụ: Khóa Bánh mì 4K" class="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-pink-500 transition text-sm">\n            </div>\n            <div>\n              <label class="block text-xs uppercase font-extrabold text-slate-500 tracking-wider mb-2">Link hết hạn sau (giờ)</label>\n              <input type="number" id="telegramInviteTtlInput" min="1" max="720" value="72" class="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-pink-500 transition text-sm">\n            </div>\n            <div class="flex items-end">\n              <p class="text-xs text-slate-500 pb-3">Mỗi order sẽ được bot tạo một link xin gia nhập riêng. Link không được công khai trước khi bill được ghi nhận.</p>\n            </div>\n          </div>\n        </div>\n\n` + marker;
  out = mustReplace(out, marker, block, 'admin delivery section');

  const helperMarker = `    function openCourseModal(course = null) {`;
  const helper = `    function toggleTelegramFields() {\n      const mode = document.getElementById('courseDeliveryModeInput')?.value || 'lms';\n      const box = document.getElementById('telegramCourseFields');\n      if (!box) return;\n      box.classList.toggle('hidden', mode !== 'telegram');\n      const chatId = document.getElementById('telegramChatIdInput');\n      if (chatId) chatId.required = mode === 'telegram';\n    }\n\n` + helperMarker;
  out = mustReplace(out, helperMarker, helper, 'admin toggle helper');

  const editMarker = `        document.getElementById("courseDescriptionInput").value = course.description || "";`;
  out = mustReplace(out, editMarker, editMarker + `\n        document.getElementById("courseDeliveryModeInput").value = course.deliveryMode || "lms";\n        document.getElementById("telegramChatIdInput").value = course.telegramChatId || "";\n        document.getElementById("telegramChatTitleInput").value = course.telegramChatTitle || "";\n        document.getElementById("telegramInviteTtlInput").value = course.telegramInviteTtlHours || 72;\n        toggleTelegramFields();`, 'admin edit values');

  const createMarker = `        document.getElementById("courseExpectedStartDateInput").value = "";`;
  out = mustReplace(out, createMarker, createMarker + `\n        document.getElementById("courseDeliveryModeInput").value = "lms";\n        document.getElementById("telegramChatIdInput").value = "";\n        document.getElementById("telegramChatTitleInput").value = "";\n        document.getElementById("telegramInviteTtlInput").value = 72;\n        toggleTelegramFields();`, 'admin create values');

  const gatherMarker = `      const description = document.getElementById("courseDescriptionInput").value.trim();`;
  out = mustReplace(out, gatherMarker, gatherMarker + `\n      const deliveryMode = document.getElementById("courseDeliveryModeInput").value;\n      const telegramChatId = document.getElementById("telegramChatIdInput").value.trim();\n      const telegramChatTitle = document.getElementById("telegramChatTitleInput").value.trim();\n      const telegramInviteTtlHours = parseInt(document.getElementById("telegramInviteTtlInput").value, 10) || 72;`, 'admin gather delivery');

  const payloadMarker = `        description,\n        bankName,`;
  out = mustReplace(out, payloadMarker, `        description,\n        deliveryMode,\n        telegramChatId,\n        telegramChatTitle,\n        telegramInviteTtlHours,\n        bankName,`, 'admin payload delivery');

  const togglePayloadMarker = `        is_published: course.is_published === true,\n        bankName: course.bankName,`;
  out = mustReplace(out, togglePayloadMarker, `        is_published: course.is_published === true,\n        deliveryMode: course.deliveryMode || 'lms',\n        telegramChatId: course.telegramChatId || '',\n        telegramChatTitle: course.telegramChatTitle || '',\n        telegramInviteTtlHours: course.telegramInviteTtlHours || 72,\n        bankName: course.bankName,`, 'admin toggle payload');
  return out;
});

console.log('Telegram order flow applied.');
