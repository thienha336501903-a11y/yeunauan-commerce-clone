import crypto from 'crypto';
import { supabase } from '../utils/supabase.js';

const normalizeExpectedStartDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()) ? String(value).trim() : null;
const validDateInput = value => String(value || '').trim() === '' || /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
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
