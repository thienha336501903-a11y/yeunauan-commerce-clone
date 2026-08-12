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
        const { syncEnrollmentToExternalSystems } = await import('../utils/sync-helpers.js');
        const actionType = existingOrder.status === 'Đã duyệt' ? 'create' : 'revoke';
        const syncResults = await syncEnrollmentToExternalSystems(existingOrder, actionType);
        const { data: updatedOrder, error: updateErr } = await supabase.from('orders').update({ sync_lms_status: syncResults.lms, sync_portal_status: syncResults.portal, sync_error: syncResults.error }).eq('id', id).select().single();
        if (updateErr) throw updateErr;
        return res.status(200).json({ success: true, data: { ...updatedOrder, syncResults } });
      }

      if (existingOrder.delivery_mode === 'telegram' && status !== undefined && status !== existingOrder.status) {
        return res.status(409).json({ error: 'Đơn Telegram phải được duyệt hoặc từ chối trong bot Telegram để quyền gia nhập và trạng thái đơn luôn đồng bộ.' });
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
          const { syncEnrollmentToExternalSystems } = await import('../utils/sync-helpers.js');
          const actionType = status === 'Đã duyệt' ? 'create' : 'revoke';
          syncResults = await syncEnrollmentToExternalSystems(data, actionType);
          const { data: finalData } = await supabase.from('orders').update({ sync_lms_status: syncResults.lms, sync_portal_status: syncResults.portal, sync_error: syncResults.error }).eq('id', id).select().single();
          if (finalData) updatedData = finalData;
        } catch (syncErr) { console.error('Order sync trigger error:', syncErr); }
      } else if (data.delivery_mode === 'telegram') {
        syncResults = { lms: 'SKIPPED_TELEGRAM', portal: 'SKIPPED_TELEGRAM', error: null };
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
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || /\s/.test(trimmed) || /[^\x00-\x7F]/.test(trimmed)) return null;
  return trimmed;
}
