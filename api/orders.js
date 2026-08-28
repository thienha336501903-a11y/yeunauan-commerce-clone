import { v2 as cloudinary } from 'cloudinary';
import { supabase } from '../utils/supabase.js';
import { extractCloudinaryBillPublicId } from '../utils/cloudinary-public-id.js';
import { syncV4EnrollmentToLms } from '../utils/v4-sync-helpers.js';
import { getV5Readiness } from '../utils/v5-readiness.js';

const VALID_ORDER_STATUSES = new Set(['Chờ duyệt', 'Đã duyệt', 'Từ chối']);
const TEST_TITLE_PREFIX = '__clone_factory_test';
const TEST_SLUG_PATTERN = /^clone-factory-test(?:-|$)/;
const TEST_DELETE_CONFIRMATION = 'DELETE_CLONE_FACTORY_TEST';
const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));

async function v5ApprovalReadiness(order) {
  if (String(order?.delivery_mode || '').toLowerCase() !== 'v5') return { ok: true };
  const courseId = String(order.course_id || '').trim();
  const courseSlug = String(order.course_slug || '').trim();
  let query = supabase.from('courses').select('id,slug,delivery_mode,active,is_published');
  query = courseId ? query.eq('id', courseId) : query.eq('slug', courseSlug);
  const { data: course, error } = await query.maybeSingle();
  if (error) throw error;
  if (!course || String(course.delivery_mode || '').toLowerCase() !== 'v5') {
    return { ok: false, code: 'v5_course_not_found', error: 'Khóa V5 của đơn hàng không còn hợp lệ.' };
  }
  if (course.active !== true || course.is_published !== true) {
    return { ok: false, code: 'v5_course_not_for_sale', error: 'Khóa V5 chưa mở bán hoặc chưa Publish.' };
  }
  const readiness = await getV5Readiness(course.id);
  if (!readiness.ready) {
    return { ok: false, code: readiness.reason || 'v5_not_ready', error: 'Khóa V5 chưa có canonical Published release hợp lệ.' };
  }
  return { ok: true, course, release: readiness.release || null };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
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
          ...(o.raw_data || {}),
          id: o.id, created_at: o.created_at, 'Thời gian': timeFormatted, time: timeFormatted,
          'Course': o.course_slug, course: o.course_slug, 'Tên khóa học': o.course_title, courseName: o.course_title,
          'Gmail': o.customer_email || '', gmail: o.customer_email || '', 'Telegram khai báo': o.telegram_claimed_username || '', telegramClaimedUsername: o.telegram_claimed_username || '', 'Link bill': o.proof_image_url, billLink: o.proof_image_url,
          'Trạng thái': o.status, status: o.status, note: o.note || '', customer_phone: o.customer_phone || '', customer_name: o.customer_name || '',
          sync_lms_status: o.sync_lms_status || 'PENDING', sync_portal_status: o.sync_portal_status || 'PENDING', sync_error: o.sync_error || '',
          delivery_mode: o.delivery_mode || 'lms', telegram_claimed_username: o.telegram_claimed_username || '', telegram_chat_id: o.telegram_chat_id || '', telegram_invite_link: o.telegram_invite_link || '', telegram_invite_expires_at: o.telegram_invite_expires_at || '',
          telegram_user_id: o.telegram_user_id || null, telegram_username: o.telegram_username || '', telegram_first_name: o.telegram_first_name || '', telegram_join_status: o.telegram_join_status || '', telegram_join_requested_at: o.telegram_join_requested_at || '', telegram_join_decided_at: o.telegram_join_decided_at || ''
        };
      }));
    }

    if (req.method === 'PUT') {
      const { id, status, note, customer_name, customer_phone, gmail, action } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Thiếu ID đơn hàng để cập nhật' });

      const { data: existingOrder, error: fetchErr } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!existingOrder) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
      if (status !== undefined && !VALID_ORDER_STATUSES.has(status)) {
        return res.status(400).json({ error: 'Trạng thái đơn hàng không hợp lệ' });
      }

      if (action === 'resync') {
        if (existingOrder.delivery_mode === 'telegram') {
          const syncResults = { lms: 'SKIPPED_TELEGRAM', portal: 'SKIPPED_TELEGRAM', error: null };
          const { data: updatedOrder, error: updateErr } = await supabase
            .from('orders')
            .update({ sync_lms_status: syncResults.lms, sync_portal_status: syncResults.portal, sync_error: null })
            .eq('id', id)
            .select()
            .single();
          if (updateErr) throw updateErr;
          return res.status(200).json({ success: true, data: { ...updatedOrder, syncResults } });
        }

        const actionType = existingOrder.status === 'Đã duyệt' ? 'create' : 'revoke';
        let syncResults;
        if (String(existingOrder.delivery_mode || '').toLowerCase() === 'v4') {
          syncResults = await syncV4EnrollmentToLms(existingOrder, actionType);
        } else {
          const { syncEnrollmentToExternalSystems } = await import('../utils/sync-helpers.js');
          syncResults = await syncEnrollmentToExternalSystems(existingOrder, actionType);
        }
        const { data: updatedOrder, error: updateErr } = await supabase.from('orders').update({ sync_lms_status: syncResults.lms, sync_portal_status: syncResults.portal, sync_error: syncResults.error }).eq('id', id).select().single();
        if (updateErr) throw updateErr;
        return res.status(200).json({ success: true, data: { ...updatedOrder, syncResults } });
      }

      if (existingOrder.delivery_mode === 'telegram' && status !== undefined && status !== existingOrder.status) {
        return res.status(409).json({ error: 'Đơn Telegram phải được duyệt hoặc từ chối trong bot Telegram để quyền gia nhập và trạng thái đơn luôn đồng bộ.' });
      }

      if (status === 'Đã duyệt' && existingOrder.status !== 'Đã duyệt' && String(existingOrder.delivery_mode || '').toLowerCase() === 'v5') {
        const gate = await v5ApprovalReadiness(existingOrder);
        if (!gate.ok) {
          return res.status(409).json({ error: gate.error, code: gate.code || 'v5_not_ready' });
        }
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
      if (status !== undefined && data.delivery_mode !== 'telegram') {
        try {
          const actionType = status === 'Đã duyệt' ? 'create' : 'revoke';
          if (String(data.delivery_mode || '').toLowerCase() === 'v4') {
            syncResults = await syncV4EnrollmentToLms(data, actionType);
          } else {
            const { syncEnrollmentToExternalSystems } = await import('../utils/sync-helpers.js');
            syncResults = await syncEnrollmentToExternalSystems(data, actionType);
          }
          const { data: finalData } = await supabase.from('orders').update({ sync_lms_status: syncResults.lms, sync_portal_status: syncResults.portal, sync_error: syncResults.error }).eq('id', id).select().single();
          if (finalData) updatedData = finalData;
        } catch (syncErr) { console.error('Order sync trigger error:', syncErr); }
      } else if (data.delivery_mode === 'telegram') {
        syncResults = { lms: 'SKIPPED_TELEGRAM', portal: 'SKIPPED_TELEGRAM', error: null };
      }
      return res.status(200).json({ success: true, data: { ...updatedData, syncResults } });
    }
    if (req.method === 'DELETE') {
      const { id, confirmation } = req.body || {};
      if (!isUuid(id) || confirmation !== TEST_DELETE_CONFIRMATION) {
        return res.status(400).json({ error: 'Yêu cầu cleanup test không hợp lệ' });
      }

      const { data: order, error: orderError } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
      if (orderError) throw orderError;
      if (!order) return res.status(404).json({ error: 'Không tìm thấy order test' });

      const courseSlug = String(order.course_slug || '').trim();
      const billName = String(order.raw_data?.billName || '').trim();
      const { data: course, error: courseError } = await supabase.from('courses').select('id,title,slug').eq('slug', courseSlug).maybeSingle();
      if (courseError) throw courseError;

      const safeTestOrder =
        String(order.delivery_mode || '').toLowerCase() === 'v4' &&
        TEST_SLUG_PATTERN.test(courseSlug) &&
        billName.startsWith(TEST_TITLE_PREFIX) &&
        String(order.course_title || '').startsWith(TEST_TITLE_PREFIX) &&
        String(course?.title || '').startsWith(TEST_TITLE_PREFIX) &&
        String(course?.slug || '') === courseSlug;
      if (!safeTestOrder) return res.status(409).json({ error: 'Cleanup bị chặn: dữ liệu không phải clone factory test hợp lệ' });

      const publicId = String(order.raw_data?.billPublicId || '').trim() || extractCloudinaryBillPublicId(order.proof_image_url, courseSlug);
      if (!publicId || !publicId.startsWith(`bill-chuyen-khoan/${courseSlug}/`)) {
        return res.status(409).json({ error: 'Không xác định được Cloudinary public ID an toàn' });
      }

      const missingCloudinaryEnv = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].filter(name => !process.env[name]);
      if (missingCloudinaryEnv.length) return res.status(500).json({ error: 'Thiếu cấu hình Cloudinary cleanup' });
      cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
      const cloudinaryResult = await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
      if (!['ok', 'not found'].includes(String(cloudinaryResult?.result || '').toLowerCase())) {
        throw new Error('Cloudinary không xác nhận xóa bill test');
      }

      const { data: removedEnrollments, error: enrollmentError } = await supabase
        .from('student_enrollments')
        .delete()
        .eq('course_slug', courseSlug)
        .eq('source_order_id', id)
        .select('id');
      if (enrollmentError) throw enrollmentError;

      const { error: deleteOrderError } = await supabase.from('orders').delete().eq('id', id);
      if (deleteOrderError) throw deleteOrderError;
      return res.status(200).json({ success: true, deletedOrderId: id, deletedEnrollmentCount: removedEnrollments?.length || 0, cloudinaryResult: cloudinaryResult.result });
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
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || /\s/.test(trimmed) || /[^\x00-\x7F]/.test(trimmed)) return null;
  return trimmed;
}
