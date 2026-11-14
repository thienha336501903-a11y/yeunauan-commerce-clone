// Bill-upload order creation shared by the website checkout (api/register.js) and the Messenger bot.
// Returns { status, body } instead of writing a response so both callers keep their own transport.
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { supabase } from './supabase.js';
import { createOrderInvite } from './telegram.js';
import { deliveryPolicy, normalizeDeliveryMode } from './delivery-policy.js';
import { cloneConfig } from './clone-config.js';
import { getV5Readiness } from './v5-readiness.js';
import { isSalePaused } from './sale-state.js';


const MAX_BILL_BYTES = 5 * 1024 * 1024;
const ALLOWED_BILL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DEFAULT_COURSE_SLUG = 'banhmi4k';
const normalizeEmail = email => String(email || '').trim().toLowerCase();
const isValidEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/[^\x00-\x7F]/.test(email);
const normalizeTelegramNick = value => String(value || '').trim().replace(/\s+/g, ' ');
const isValidTelegramNick = value => value.length >= 2 && value.length <= 64 && !/[\x00-\x1F\x7F]/.test(value);
const normalizeBase64 = value => String(value || '').replace(/\s+/g, '');
const isValidBase64 = value => value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

async function cleanupUnpersistedBill(publicId) {
  const id = String(publicId || '').trim();
  if (!id) return;
  try {
    await cloudinary.uploader.destroy(id, { resource_type: 'image', invalidate: true });
  } catch (error) {
    // Preserve the original order persistence error, but leave an actionable log
    // if Cloudinary cleanup itself fails.
    console.error('REGISTER_BILL_CLEANUP_ERROR:', id, error);
  }
}

const reply = (status, body) => ({ status, body });

// rawExtra is merged into orders.raw_data (Messenger: { channel, psid }); callers pass only trusted keys.
export async function createBillOrder(input, { rawExtra = {} } = {}) {
  try {
    const runtime = cloneConfig();
    const { gmail, telegramNick, billName, billType, billData, course } = input || {};
    const cleanEmail = normalizeEmail(gmail);
    const cleanTelegramNick = normalizeTelegramNick(telegramNick);
    const cleanBillType = String(billType || '').trim().toLowerCase();
    const cleanBillData = normalizeBase64(billData);
    const courseSlug = String(course || DEFAULT_COURSE_SLUG).trim().toLowerCase();

    if (!billName || !cleanBillType || !cleanBillData) return reply(400, { error: 'Thiếu dữ liệu' });
    if (!ALLOWED_BILL_TYPES.has(cleanBillType)) return reply(400, { error: 'Chỉ nhận file JPG, PNG hoặc WEBP' });
    if (!isValidBase64(cleanBillData)) return reply(400, { error: 'Dữ liệu ảnh bill không hợp lệ' });
    const billBytes = Buffer.byteLength(cleanBillData, 'base64');
    if (!billBytes) return reply(400, { error: 'Ảnh bill trống' });
    if (billBytes > MAX_BILL_BYTES) return reply(413, { error: 'Ảnh bill quá lớn. Vui lòng chọn ảnh dưới 5MB' });
    if (!/^[a-z0-9_-]+$/.test(courseSlug)) return reply(400, { error: 'Mã khóa học không hợp lệ' });

    const { data: courseRec, error: courseError } = await supabase
      .from('courses')
      .select('id, image_url, title, active, is_published, raw_data, delivery_mode, telegram_chat_id, telegram_invite_ttl_hours')
      .eq('slug', courseSlug)
      .maybeSingle();
    if (courseError) throw courseError;
    if (!courseRec || courseRec.active === false) return reply(404, { error: 'Khóa học không tồn tại hoặc chưa mở đăng ký' });
    if (isSalePaused(courseRec)) {
      return reply(409, { error: 'Khóa học đang tạm dừng nhận đăng ký.', code: 'sale_paused' });
    }

    const deliveryMode = normalizeDeliveryMode(courseRec.delivery_mode);
    const policy = deliveryPolicy(deliveryMode);
    if (deliveryMode === 'v4' && courseRec.is_published !== true && courseRec.raw_data?.v4SellBeforePublishAcknowledged !== true) {
      return reply(409, { error: 'Khóa học V4 chưa sẵn sàng nội dung nên chưa thể nhận đăng ký.' });
    }
    if (deliveryMode === 'v5') {
      if (courseRec.active !== true) {
        return reply(409, { error: 'Khóa học V5 chưa mở bán nên chưa thể nhận đăng ký.' });
      }
      if (courseRec.is_published === true) {
        const readiness = await getV5Readiness(courseRec.id);
        if (!readiness.ready) {
          console.warn('[register] V5 order blocked by canonical readiness:', courseSlug, readiness.reason);
          return reply(409, {
            error: 'Khóa học V5 chưa có release Published hợp lệ nên chưa thể nhận đăng ký.',
            code: readiness.reason || 'v5_not_ready'
          });
        }
      }
    }
    const telegramChatId = deliveryMode === 'telegram' ? String(courseRec.telegram_chat_id || '').trim() : '';
    if (deliveryMode === 'telegram' && !telegramChatId) {
      return reply(409, { error: 'Khóa học Telegram đang chờ Admin kết nối group/channel. Vui lòng thử lại sau.' });
    }

    if (policy.requiresTelegramUsername) {
      if (!cleanTelegramNick) return reply(400, { error: 'Vui lòng nhập nick Telegram của bạn' });
      if (!isValidTelegramNick(cleanTelegramNick)) return reply(400, { error: 'Nick Telegram phải từ 2 đến 64 ký tự' });
    } else if (policy.requiresEmail) {
      if (!cleanEmail) return reply(400, { error: 'Vui lòng nhập Gmail của bạn' });
      if (!isValidEmail(cleanEmail)) return reply(400, { error: 'Địa chỉ email không hợp lệ' });
    }

    const missingCloudinaryEnv = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].filter(name => !process.env[name]);
    if (missingCloudinaryEnv.length) return reply(500, { error: 'Hệ thống upload bill chưa được cấu hình đầy đủ' });

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
      raw_data: { ...rawExtra, billName: String(billName).slice(0, 120), billType: cleanBillType, billPublicId: uploadResult.public_id || null, contactType: deliveryMode === 'telegram' ? 'telegram' : 'email', ...(deliveryMode === 'telegram' ? { telegramClaimedUsername: cleanTelegramNick } : {}) }
    };

    if (deliveryMode === 'telegram') {
      orderPayload.sync_lms_status = 'SKIPPED_TELEGRAM';
      orderPayload.sync_portal_status = 'SKIPPED_TELEGRAM';
      orderPayload.telegram_join_status = 'invite_creating';
    }
    if (deliveryMode === 'v4') orderPayload.sync_portal_status = 'SKIPPED_V4';
    if (deliveryMode === 'v5') orderPayload.sync_portal_status = 'SKIPPED_V5';

    const { error: insertError } = await supabase.from('orders').insert(orderPayload);
    if (insertError) {
      await cleanupUnpersistedBill(uploadResult.public_id);
      throw insertError;
    }

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
        return reply(200, { success: true, file: billLink, course: courseSlug, courseName: finalCourseName, orderId, deliveryMode: 'telegram', telegramInviteLink: invite.inviteLink, telegramInviteExpiresAt: invite.expiresAt });
      } catch (telegramError) {
        console.error('TELEGRAM_INVITE_ERROR:', telegramError);
        await supabase.from('orders').update({ telegram_join_status: 'invite_error', sync_error: String(telegramError.message || telegramError).slice(0, 500), updated_at: new Date().toISOString() }).eq('id', orderId);
        return reply(200, { success: true, file: billLink, course: courseSlug, courseName: finalCourseName, orderId, deliveryMode: 'telegram', telegramReady: false, message: 'Đã nhận bill nhưng chưa tạo được link Telegram. Admin sẽ xử lý đơn này.' });
      }
    }

    // M0E: Legacy portal mirroring is retired. All non-Telegram course-manager
    // links stay on the Main-backed LMS surface.

    const managerPath = runtime.lmsPublicUrl.replace(/\/$/, '')
      + '/my-courses.html?registered=1&course=' + encodeURIComponent(courseSlug);
    return reply(200, { success: true, file: billLink, course: courseSlug, courseName: finalCourseName, orderId, deliveryMode, managerPath });
  } catch (error) {
    console.error('REGISTER_ERROR:', error);
    return reply(500, { error: 'Không thể ghi nhận đăng ký. Vui lòng thử lại' });
  }
}
