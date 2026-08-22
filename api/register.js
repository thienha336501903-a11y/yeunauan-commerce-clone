import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { supabase } from '../utils/supabase.js';
import { createOrderInvite } from '../utils/telegram.js';
import { deliveryPolicy, normalizeDeliveryMode } from '../utils/delivery-policy.js';

const MAX_BILL_BYTES = 5 * 1024 * 1024;
const ALLOWED_BILL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DEFAULT_COURSE_SLUG = 'banhmi4k';
const normalizeEmail = email => String(email || '').trim().toLowerCase();
const isValidEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/[^\x00-\x7F]/.test(email);
const normalizeTelegramNick = value => String(value || '').trim().replace(/\s+/g, ' ');
const isValidTelegramNick = value => value.length >= 2 && value.length <= 64 && !/[\x00-\x1F\x7F]/.test(value);
const normalizeBase64 = value => String(value || '').replace(/\s+/g, '');
const isValidBase64 = value => value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { gmail, telegramNick, billName, billType, billData, course } = req.body || {};
    const cleanEmail = normalizeEmail(gmail);
    const cleanTelegramNick = normalizeTelegramNick(telegramNick);
    const cleanBillType = String(billType || '').trim().toLowerCase();
    const cleanBillData = normalizeBase64(billData);
    const courseSlug = String(course || DEFAULT_COURSE_SLUG).trim().toLowerCase();

    if (!billName || !cleanBillType || !cleanBillData) return res.status(400).json({ error: 'Thiếu dữ liệu' });
    if (!ALLOWED_BILL_TYPES.has(cleanBillType)) return res.status(400).json({ error: 'Chỉ nhận file JPG, PNG hoặc WEBP' });
    if (!isValidBase64(cleanBillData)) return res.status(400).json({ error: 'Dữ liệu ảnh bill không hợp lệ' });
    const billBytes = Buffer.byteLength(cleanBillData, 'base64');
    if (!billBytes) return res.status(400).json({ error: 'Ảnh bill trống' });
    if (billBytes > MAX_BILL_BYTES) return res.status(413).json({ error: 'Ảnh bill quá lớn. Vui lòng chọn ảnh dưới 5MB' });
    if (!/^[a-z0-9_-]+$/.test(courseSlug)) return res.status(400).json({ error: 'Mã khóa học không hợp lệ' });

    const { data: courseRec, error: courseError } = await supabase
      .from('courses')
      .select('id, image_url, title, active, is_published, raw_data, delivery_mode, telegram_chat_id, telegram_invite_ttl_hours')
      .eq('slug', courseSlug)
      .maybeSingle();
    if (courseError) throw courseError;
    if (!courseRec || courseRec.active === false) return res.status(404).json({ error: 'Khóa học không tồn tại hoặc chưa mở đăng ký' });

    const deliveryMode = normalizeDeliveryMode(courseRec.delivery_mode);
    const policy = deliveryPolicy(deliveryMode);
    if (deliveryMode === 'v4' && courseRec.is_published !== true && courseRec.raw_data?.v4SellBeforePublishAcknowledged !== true) {
      return res.status(409).json({ error: 'Khóa học V4 chưa sẵn sàng nội dung nên chưa thể nhận đăng ký.' });
    }
    const telegramChatId = deliveryMode === 'telegram' ? String(courseRec.telegram_chat_id || '').trim() : '';
    if (deliveryMode === 'telegram' && !telegramChatId) {
      return res.status(409).json({ error: 'Khóa học Telegram đang chờ Admin kết nối group/channel. Vui lòng thử lại sau.' });
    }

    if (policy.requiresTelegramUsername) {
      if (!cleanTelegramNick) return res.status(400).json({ error: 'Vui lòng nhập nick Telegram của bạn' });
      if (!isValidTelegramNick(cleanTelegramNick)) return res.status(400).json({ error: 'Nick Telegram phải từ 2 đến 64 ký tự' });
    } else if (policy.requiresEmail) {
      if (!cleanEmail) return res.status(400).json({ error: 'Vui lòng nhập Gmail của bạn' });
      if (!isValidEmail(cleanEmail)) return res.status(400).json({ error: 'Địa chỉ email không hợp lệ' });
    }

    const missingCloudinaryEnv = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].filter(name => !process.env[name]);
    if (missingCloudinaryEnv.length) return res.status(500).json({ error: 'Hệ thống upload bill chưa được cấu hình đầy đủ' });

    cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
    const uploadResult = await cloudinary.uploader.upload('data:' + cleanBillType + ';base64,' + cleanBillData, { folder: 'bill-chuyen-khoan/' + courseSlug, resource_type: 'image' });
    const billLink = uploadResult.secure_url;
    const finalCourseName = courseRec.title || courseSlug;
    const thumbnail = courseRec.image_url || '';
    const orderId = crypto.randomUUID();

    const orderPayload = {
      id: orderId,
      course_id: courseRec.id,
      course_slug: courseSlug,
      course_title: finalCourseName,
      customer_email: deliveryMode !== 'telegram' ? cleanEmail : null,
      telegram_claimed_username: deliveryMode === 'telegram' ? cleanTelegramNick : null,
      proof_image_url: billLink,
      status: 'Chờ duyệt',
      delivery_mode: deliveryMode,
      telegram_chat_id: deliveryMode === 'telegram' ? telegramChatId : null,
      raw_data: { billName: String(billName).slice(0, 120), billType: cleanBillType, contactType: deliveryMode === 'telegram' ? 'telegram' : 'email', ...(deliveryMode === 'telegram' ? { telegramClaimedUsername: cleanTelegramNick } : {}) }
    };

    if (deliveryMode === 'telegram') {
      orderPayload.sync_lms_status = 'SKIPPED_TELEGRAM';
      orderPayload.sync_portal_status = 'SKIPPED_TELEGRAM';
      orderPayload.telegram_join_status = 'invite_creating';
    }
    if (deliveryMode === 'v4') {
      orderPayload.sync_portal_status = 'SKIPPED_V4';
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

    // Only legacy LMS orders are mirrored into the legacy student Portal.
    // V4 has its own course manager in LMS Clone and reads this order directly.
    if (deliveryMode === 'lms') {
      const system1Url = process.env.SYSTEM1_URL;
      const syncSecret = process.env.INTERNAL_SYNC_SECRET;
      if (system1Url && syncSecret) {
        try {
          await fetch(system1Url.trim().replace(/\/$/, '') + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': syncSecret }, body: JSON.stringify({ action: 'syncPendingOrder', email: cleanEmail, courseSlug, courseName: finalCourseName, thumbnail }) });
        } catch (syncErr) { console.error('Error syncing pending order to Portal:', syncErr); }
      }
    }

    const managerPath = deliveryMode === 'v4'
      ? '/my-courses.html?registered=1&course=' + encodeURIComponent(courseSlug)
      : 'https://yeunauan.live/my-courses';
    return res.status(200).json({ success: true, file: billLink, course: courseSlug, courseName: finalCourseName, orderId, deliveryMode, managerPath });
  } catch (error) {
    console.error('REGISTER_ERROR:', error);
    return res.status(500).json({ error: 'Không thể ghi nhận đăng ký. Vui lòng thử lại' });
  }
}
