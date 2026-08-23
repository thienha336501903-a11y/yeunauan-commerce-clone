import crypto from 'crypto';
import { supabase } from '../utils/supabase.js';
import { syncV4CourseToLms } from '../utils/v4-sync-helpers.js';
import { normalizeDeliveryMode } from '../utils/delivery-policy.js';
import { handleV4Workflow } from '../utils/v4-workflow.js';

const normalizeExpectedStartDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()) ? String(value).trim() : null;
const validDateInput = value => String(value || '').trim() === '' || /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
const validSlug = value => /^[a-z0-9_-]+$/.test(String(value || '').trim());
const validUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
const mode = normalizeDeliveryMode;
const ttl = value => Math.min(720, Math.max(1, Number.parseInt(value, 10) || 72));
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

async function actualIndexedCount(sourceId) {
  const { count, error } = await supabase
    .from('tgcloner_source_messages')
    .select('id', { count: 'exact', head: true })
    .eq('source_id', sourceId);
  if (error) throw error;
  return Number(count || 0);
}

async function handleV4Sources(req, res) {
  if (req.method === 'GET') {
    const courseSlug = String(req.query?.courseSlug || '').trim();
    if (courseSlug && !validSlug(courseSlug)) return res.status(400).json({ error: 'Slug khóa học không hợp lệ' });

    const [{ data: sources, error: sourceError }, { data: mappings, error: mappingError }] = await Promise.all([
      supabase
        .from('tgcloner_sources')
        .select('id,chat_id,title,username,active,indexed_at,indexed_message_count,created_at,updated_at')
        .order('created_at', { ascending: false }),
      supabase
        .from('lms_v4_telegram_course_sources')
        .select('course_slug,source_id,enabled,media_mode,created_at,updated_at')
    ]);
    if (sourceError) throw sourceError;
    if (mappingError) throw mappingError;

    const mappedCoursesBySource = new Map();
    for (const row of mappings || []) {
      if (!row?.source_id) continue;
      const list = mappedCoursesBySource.get(row.source_id) || [];
      list.push(row.course_slug);
      mappedCoursesBySource.set(row.source_id, list);
    }

    const countedSources = await Promise.all((sources || []).map(async source => {
      const indexedMessageCount = await actualIndexedCount(source.id);
      return {
        ...source,
        indexed_message_count: indexedMessageCount,
        mappedCourses: mappedCoursesBySource.get(source.id) || [],
        ready: indexedMessageCount > 0
      };
    }));

    const current = courseSlug ? (mappings || []).find(row => row.course_slug === courseSlug) || null : null;
    return res.status(200).json({ success: true, courseSlug: courseSlug || null, mapping: current, sources: countedSources });
  }

  if (req.method === 'POST') {
    const courseSlug = String(req.body?.courseSlug || '').trim();
    const sourceId = String(req.body?.sourceId || '').trim();
    if (!validSlug(courseSlug)) return res.status(400).json({ error: 'Slug khóa học không hợp lệ' });
    if (!validUuid(sourceId)) return res.status(400).json({ error: 'Nguồn Telegram không hợp lệ' });

    const [{ data: course, error: courseError }, { data: source, error: sourceError }, { data: currentMapping, error: currentMappingError }] = await Promise.all([
      supabase.from('courses').select('id,slug,title,delivery_mode,is_published').eq('slug', courseSlug).maybeSingle(),
      supabase.from('tgcloner_sources').select('id,chat_id,title,username,active,indexed_at,indexed_message_count').eq('id', sourceId).maybeSingle()
      ,supabase.from('lms_v4_telegram_course_sources').select('source_id').eq('course_slug', courseSlug).maybeSingle()
    ]);
    if (courseError) throw courseError;
    if (sourceError) throw sourceError;
    if (currentMappingError) throw currentMappingError;
    if (!course) return res.status(404).json({ error: 'Không tìm thấy khóa học' });
    if (String(course.delivery_mode || '').toLowerCase() !== 'v4') return res.status(409).json({ error: 'Chỉ khóa Học trên V4 Web mới được gắn nguồn V4' });
    if (!source) return res.status(404).json({ error: 'Không tìm thấy nguồn Telegram đã đăng ký' });
    if (course.is_published === true && currentMapping?.source_id !== sourceId) {
      return res.status(409).json({ error: 'Hãy chuyển khóa V4 về Draft trước khi đổi nguồn nội dung.' });
    }

    const { data: mapping, error } = await supabase
      .from('lms_v4_telegram_course_sources')
      .upsert({ course_slug: courseSlug, source_id: sourceId, enabled: true, media_mode: 'telegram_bot_poc', updated_at: new Date().toISOString() }, { onConflict: 'course_slug' })
      .select('course_slug,source_id,enabled,media_mode,created_at,updated_at')
      .single();
    if (error) throw error;

    const indexedMessageCount = await actualIndexedCount(sourceId);
    return res.status(200).json({ success: true, mapping, source: { ...source, indexed_message_count: indexedMessageCount, ready: indexedMessageCount > 0 } });
  }

  if (req.method === 'DELETE') {
    const courseSlug = String(req.body?.courseSlug || req.query?.courseSlug || '').trim();
    if (!validSlug(courseSlug)) return res.status(400).json({ error: 'Slug khóa học không hợp lệ' });
    const [{ data: course, error: courseError }, { count: orderCount, error: orderError }, { count: enrollmentCount, error: enrollmentError }] = await Promise.all([
      supabase.from('courses').select('is_published').eq('slug', courseSlug).maybeSingle(),
      supabase.from('orders').select('id', { count: 'exact', head: true }).eq('course_slug', courseSlug),
      supabase.from('student_enrollments').select('id', { count: 'exact', head: true }).eq('course_slug', courseSlug)
    ]);
    if (courseError) throw courseError;
    if (orderError) throw orderError;
    if (enrollmentError) throw enrollmentError;
    if (course?.is_published === true || Number(orderCount || 0) > 0 || Number(enrollmentCount || 0) > 0) {
      return res.status(409).json({ error: 'Không thể tháo nguồn khi khóa đã Publish hoặc đang có đơn/enrollment.' });
    }
    const { error } = await supabase.from('lms_v4_telegram_course_sources').delete().eq('course_slug', courseSlug);
    if (error) throw error;
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function syncCourseIfLms(course, dataId) {
  const deliveryMode = mode(course.deliveryMode);
  if (deliveryMode === 'telegram') {
    const result = { lms: 'SKIPPED_TELEGRAM', portal: 'SKIPPED_TELEGRAM', error: null };
    await supabase.from('courses').update({ sync_lms_status: result.lms, sync_portal_status: result.portal, sync_error: null }).eq('id', dataId);
    return result;
  }

  if (deliveryMode === 'v4') {
    const result = await syncV4CourseToLms(course);
    await supabase.from('courses').update({ sync_lms_status: result.lms, sync_portal_status: result.portal, sync_error: result.error }).eq('id', dataId);
    return result;
  }

  const { syncCourseToExternalSystems } = await import('../utils/sync-helpers.js');
  const result = await syncCourseToExternalSystems({ slug: course.slug, courseName: course.courseName, price: course.price, imageUrl: course.imageUrl, expected_start_date: course.expected_start_date, active: course.active, teacher_name: course.teacher_name });
  await supabase.from('courses').update({ sync_lms_status: result.lms, sync_portal_status: result.portal, sync_error: result.error }).eq('id', dataId);
  return result;
}

async function validateV4ReadySource(courseSlug) {
  const { data: mapping, error: mappingError } = await supabase
    .from('lms_v4_telegram_course_sources')
    .select('source_id,enabled')
    .eq('course_slug', courseSlug)
    .maybeSingle();
  if (mappingError) throw mappingError;
  if (!mapping || mapping.enabled !== true || !mapping.source_id) {
    return { ok: false, error: 'Khóa V4 chưa được gắn nguồn nội dung Telegram. Hãy chọn Nguồn nội dung V4 trước khi chuyển Sẵn sàng.' };
  }

  const { data: source, error: sourceError } = await supabase
    .from('tgcloner_sources')
    .select('id,title,username,indexed_at')
    .eq('id', mapping.source_id)
    .maybeSingle();
  if (sourceError) throw sourceError;
  if (!source) return { ok: false, error: 'Nguồn Telegram của khóa V4 không còn tồn tại.' };

  const indexedMessageCount = await actualIndexedCount(mapping.source_id);
  if (indexedMessageCount < 1) {
    return { ok: false, error: 'Nguồn Telegram chưa có bài nào được index. Hãy đưa nội dung vào nguồn V4 và kiểm tra index trước khi chuyển Sẵn sàng.' };
  }
  return { ok: true, source, indexedMessageCount };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const adminPassword = req.headers['x-admin-password'];
  if (!adminPassword || adminPassword !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized: Mật khẩu Admin không chính xác hoặc trống.' });

  try {
    const requestAction = String(req.query?.action || '').trim().toLowerCase();
    if (requestAction === 'v4-sources') return await handleV4Sources(req, res);
    if (requestAction === 'v4-workflow') return await handleV4Workflow(req, res);

    if (req.method === 'GET') {
      const { data: courses, error } = await supabase.from('courses').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json(courses.map(c => ({
        ...(c.raw_data || {}),
        id: c.id, slug: c.slug, courseName: c.title, price: c.price || '', imageUrl: c.image_url || c.raw_data?.imageUrl || c.raw_data?.posterUrl || c.raw_data?.posterImageUrl || c.raw_data?.thumbnail || c.raw_data?.heroUrl || c.raw_data?.heroImageUrl || c.raw_data?.coverUrl || '',
        expected_start_date: c.expected_start_date || '', active: c.active, sort_order: c.sort_order, description: c.description || '', teacher_name: c.teacher_name || '', is_published: c.is_published === true, created_at: c.created_at,
        sync_lms_status: c.sync_lms_status || 'PENDING', sync_portal_status: c.sync_portal_status || 'PENDING', sync_error: c.sync_error || '',
        deliveryMode: mode(c.delivery_mode), telegramChatId: c.telegram_chat_id || '', telegramChatTitle: c.telegram_chat_title || '', telegramInviteTtlHours: c.telegram_invite_ttl_hours || 72,
        telegramConnected: Boolean(String(c.telegram_chat_id || '').trim())
      })));
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const body = req.body || {};
      const id = body.id;
      const slug = String(body.slug || '').trim();
      const courseName = String(body.courseName || body.title || '').trim();
      if (!slug || !courseName) return res.status(400).json({ error: 'Thiếu thông tin bắt buộc (slug, title)' });
      if (!validDateInput(body.expected_start_date)) return res.status(400).json({ error: 'Lịch khai giảng dự kiến phải có định dạng YYYY-MM-DD' });

      const hasDeliveryMode = hasOwn(body, 'deliveryMode') || hasOwn(body, 'delivery_mode');
      const hasTelegramChatId = hasOwn(body, 'telegramChatId') || hasOwn(body, 'telegram_chat_id');
      const hasTelegramChatTitle = hasOwn(body, 'telegramChatTitle') || hasOwn(body, 'telegram_chat_title');
      const hasTelegramTtl = hasOwn(body, 'telegramInviteTtlHours') || hasOwn(body, 'telegram_invite_ttl_hours');
      let deliveryMode = mode(body.deliveryMode || body.delivery_mode);
      const telegramChatId = String(body.telegramChatId || body.telegram_chat_id || '').trim();

      const rawDataPatch = {};
      for (const key of ['bankName', 'bankAccount', 'bankOwner', 'transferNote', 'qrImageUrl']) {
        if (hasOwn(body, key)) rawDataPatch[key] = String(body[key] || '').trim();
      }
      const base = {
        slug, title: courseName, price: body.price, image_url: String(body.imageUrl || '').trim(), expected_start_date: normalizeExpectedStartDate(body.expected_start_date),
        active: body.active !== undefined ? body.active : true, sort_order: body.sort_order !== undefined ? Number.parseInt(body.sort_order, 10) || 0 : 0,
        description: body.description || '', teacher_name: body.teacher_name || '', delivery_mode: deliveryMode,
        telegram_chat_id: deliveryMode === 'telegram' ? telegramChatId || null : null,
        telegram_chat_title: deliveryMode === 'telegram' ? String(body.telegramChatTitle || body.telegram_chat_title || '').trim() || null : null,
        telegram_invite_ttl_hours: ttl(body.telegramInviteTtlHours || body.telegram_invite_ttl_hours),
        raw_data: rawDataPatch
      };
      if (body.is_published !== undefined) base.is_published = body.is_published === true;

      let data;
      if (req.method === 'POST') {
        if (deliveryMode === 'v4' && base.is_published === true) {
          return res.status(409).json({ error: 'Khóa V4 mới phải tạo ở trạng thái Chờ lên bài, sau đó gắn nguồn nội dung rồi mới chuyển Sẵn sàng.' });
        }
        if (deliveryMode === 'v4' && base.active === true && body.allowSellingUnpublishedV4 !== true) {
          return res.status(409).json({ error: 'Khóa V4 mới phải để Tắt bán cho đến khi nội dung đã Publish.' });
        }
        if (deliveryMode === 'v4') {
          base.raw_data.v4SellBeforePublishAcknowledged = base.active === true && body.allowSellingUnpublishedV4 === true;
        }
        base.id = id || crypto.randomUUID();
        const result = await supabase.from('courses').insert(base).select().single();
        if (result.error) throw result.error;
        data = result.data;
      } else {
        if (!id) return res.status(400).json({ error: 'Thiếu ID khóa học để cập nhật' });
        const { data: existing, error: existingErr } = await supabase
          .from('courses')
          .select('slug,image_url,raw_data,expected_start_date,delivery_mode,telegram_chat_id,telegram_chat_title,telegram_invite_ttl_hours,is_published,active')
          .eq('id', id)
          .maybeSingle();
        if (existingErr) throw existingErr;
        if (!existing) return res.status(404).json({ error: 'Không tìm thấy khóa học' });

        if (!hasDeliveryMode) {
          deliveryMode = mode(existing.delivery_mode);
          base.delivery_mode = deliveryMode;
        }

        const slugChanged = existing.slug !== slug;
        const modeChanged = mode(existing.delivery_mode) !== deliveryMode;
        if (slugChanged || modeChanged) {
          const [{ count: orderCount, error: orderError }, { count: enrollmentCount, error: enrollmentError }, { count: mappingCount, error: mappingError }] = await Promise.all([
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('course_slug', existing.slug),
            supabase.from('student_enrollments').select('id', { count: 'exact', head: true }).eq('course_slug', existing.slug),
            supabase.from('lms_v4_telegram_course_sources').select('source_id', { count: 'exact', head: true }).eq('course_slug', existing.slug)
          ]);
          if (orderError) throw orderError;
          if (enrollmentError) throw enrollmentError;
          if (mappingError) throw mappingError;
          if (existing.is_published === true || Number(orderCount || 0) || Number(enrollmentCount || 0) || Number(mappingCount || 0)) {
            return res.status(409).json({ error: 'Không thể đổi slug/hình thức học khi khóa đã Publish hoặc đang có đơn, enrollment hay nguồn V4.' });
          }
        }

        base.image_url = base.image_url || existing.image_url || '';
        base.raw_data = { ...(existing.raw_data || {}), ...base.raw_data };
        if (!hasOwn(body, 'expected_start_date')) delete base.expected_start_date;
        if (!hasTelegramTtl) base.telegram_invite_ttl_hours = existing.telegram_invite_ttl_hours || 72;

        if (deliveryMode === 'telegram') {
          if (!hasTelegramChatId) base.telegram_chat_id = existing.telegram_chat_id || null;
          if (!hasTelegramChatTitle) base.telegram_chat_title = existing.telegram_chat_title || null;
        } else {
          base.telegram_chat_id = null;
          base.telegram_chat_title = null;
        }

        if (deliveryMode === 'v4' && base.is_published === true) {
          const readyCheck = await validateV4ReadySource(slug);
          if (!readyCheck.ok) return res.status(409).json({ error: readyCheck.error });
        }
        const effectivePublished = hasOwn(base, 'is_published') ? base.is_published : existing.is_published === true;
        if (deliveryMode === 'v4' && base.active === true && !effectivePublished && body.allowSellingUnpublishedV4 !== true) {
          return res.status(409).json({ error: 'Không thể bật bán khóa V4 khi nội dung chưa Publish.' });
        }
        if (deliveryMode === 'v4') {
          base.raw_data.v4SellBeforePublishAcknowledged = base.active === true && !effectivePublished && body.allowSellingUnpublishedV4 === true;
        } else {
          delete base.raw_data.v4SellBeforePublishAcknowledged;
        }

        const result = await supabase.from('courses').update(base).eq('id', id).select().single();
        if (result.error) throw result.error;
        data = result.data;
      }

      let syncResults = { lms: 'PENDING', portal: 'PENDING', error: null };
      try { syncResults = await syncCourseIfLms({ ...body, slug, courseName, deliveryMode }, data.id); } catch (syncErr) { console.error('Course sync trigger error:', syncErr); syncResults.error = String(syncErr.message || syncErr); }
      return res.status(req.method === 'POST' ? 201 : 200).json({ success: true, data: { ...data, syncResults, telegramConnected: Boolean(String(data.telegram_chat_id || '').trim()) } });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || req.query;
      if (!id) return res.status(400).json({ error: 'Thiếu ID khóa học để xóa' });
      const { data: course, error: courseErr } = await supabase.from('courses').select('slug,delivery_mode').eq('id', id).maybeSingle();
      if (courseErr) throw courseErr;
      if (!course) return res.status(404).json({ error: 'Không tìm thấy khóa học' });
      const [{ count: orderCount, error: orderErr }, { count: enrollmentCount, error: enrollmentErr }, { count: mappingCount, error: mappingErr }] = await Promise.all([
        supabase.from('orders').select('id', { count: 'exact', head: true }).eq('course_slug', course.slug),
        supabase.from('student_enrollments').select('id', { count: 'exact', head: true }).eq('course_slug', course.slug),
        supabase.from('lms_v4_telegram_course_sources').select('source_id', { count: 'exact', head: true }).eq('course_slug', course.slug)
      ]);
      if (orderErr) throw orderErr;
      if (enrollmentErr) throw enrollmentErr;
      if (mappingErr) throw mappingErr;
      if (Number(orderCount || 0) || Number(enrollmentCount || 0) || Number(mappingCount || 0)) {
        return res.status(409).json({
          error: `Không thể xóa khóa đang có liên kết dữ liệu (đơn: ${Number(orderCount || 0)}, enrollment: ${Number(enrollmentCount || 0)}, nguồn V4: ${Number(mappingCount || 0)}).`
        });
      }
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
