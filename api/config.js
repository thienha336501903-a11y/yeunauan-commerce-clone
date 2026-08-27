import { supabase } from '../utils/supabase.js';
import { normalizeDeliveryMode } from '../utils/delivery-policy.js';
import { cloneConfig } from '../utils/clone-config.js';

const clean = value => String(value || '').trim();
const validSlug = value => /^[a-z0-9_-]+$/.test(clean(value));

function requireAdmin(req, res) {
  const adminPassword = String(req.headers['x-admin-password'] || '');
  if (!adminPassword || adminPassword !== String(process.env.ADMIN_PASSWORD || '')) {
    res.status(401).json({ error: 'Unauthorized: Mật khẩu Admin không chính xác hoặc trống.' });
    return false;
  }
  return true;
}

async function v5CourseRows() {
  const { data: courses, error: courseError } = await supabase
    .from('courses')
    .select('id,slug,title,subtitle,price,image_url,description,teacher_name,active,is_published,sort_order,created_at,updated_at')
    .eq('delivery_mode', 'v5')
    .order('created_at', { ascending: false });
  if (courseError) throw courseError;

  const courseIds = (courses || []).map(course => course.id);
  let configs = [];
  if (courseIds.length) {
    const { data, error } = await supabase
      .from('v5_course_configs')
      .select('course_id,source_mode,status,published_release_id,updated_at')
      .in('course_id', courseIds);
    if (error) throw error;
    configs = data || [];
  }
  const configByCourse = new Map(configs.map(config => [config.course_id, config]));
  return (courses || []).map(course => ({ ...course, v5: configByCourse.get(course.id) || null }));
}

async function handleV5Admin(req, res) {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'GET') {
    return res.status(200).json({ success: true, courses: await v5CourseRows() });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const slug = clean(body.slug).toLowerCase();
    const title = clean(body.title || body.courseName);
    if (!validSlug(slug)) return res.status(400).json({ error: 'Slug V5 không hợp lệ.' });
    if (!title) return res.status(400).json({ error: 'Thiếu tên khóa học V5.' });

    const { data: existing, error: existingError } = await supabase.from('courses').select('id,delivery_mode').eq('slug', slug).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return res.status(409).json({ error: 'Slug khóa học đã tồn tại.' });

    const { data: course, error: insertError } = await supabase
      .from('courses')
      .insert({
        slug,
        title,
        subtitle: clean(body.subtitle) || null,
        price: clean(body.price) || null,
        image_url: clean(body.imageUrl) || null,
        description: clean(body.description) || null,
        teacher_name: clean(body.teacherName) || null,
        delivery_mode: 'v5',
        active: false,
        is_published: false,
        sort_order: Number.parseInt(body.sortOrder, 10) || 0,
        raw_data: {}
      })
      .select('id,slug,title,active,is_published')
      .single();
    if (insertError) throw insertError;

    const { error: configError } = await supabase
      .from('v5_course_configs')
      .insert({ course_id: course.id, source_mode: 'direct', status: 'draft' });
    if (configError) {
      await supabase.from('courses').delete().eq('id', course.id).eq('delivery_mode', 'v5');
      throw configError;
    }

    return res.status(201).json({ success: true, course, courses: await v5CourseRows() });
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    const courseId = clean(body.id || body.courseId);
    const action = clean(body.action);
    if (!courseId) return res.status(400).json({ error: 'Thiếu courseId.' });

    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('id,slug,title,active,is_published,delivery_mode')
      .eq('id', courseId)
      .maybeSingle();
    if (courseError) throw courseError;
    if (!course || normalizeDeliveryMode(course.delivery_mode) !== 'v5') {
      return res.status(404).json({ error: 'Không tìm thấy khóa V5.' });
    }

    const { data: config, error: configError } = await supabase
      .from('v5_course_configs')
      .select('status,published_release_id')
      .eq('course_id', course.id)
      .maybeSingle();
    if (configError) throw configError;

    const contentPublished = config?.status === 'published' && Boolean(config?.published_release_id);
    if (action === 'openLearningGate') {
      if (!contentPublished) return res.status(409).json({ error: 'Nội dung V5 chưa Publish; chưa thể mở cổng học.' });
      const { error } = await supabase.from('courses').update({ is_published: true, updated_at: new Date().toISOString() }).eq('id', course.id).eq('delivery_mode', 'v5');
      if (error) throw error;
    } else if (action === 'setActive') {
      const nextActive = body.active === true;
      if (nextActive && (!contentPublished || course.is_published !== true)) {
        return res.status(409).json({ error: 'V5 phải Publish nội dung và mở cổng học trước khi bật bán.' });
      }
      const { error } = await supabase.from('courses').update({ active: nextActive, updated_at: new Date().toISOString() }).eq('id', course.id).eq('delivery_mode', 'v5');
      if (error) throw error;
    } else {
      return res.status(400).json({ error: 'V5 admin action không hợp lệ.' });
    }

    return res.status(200).json({ success: true, courses: await v5CourseRows() });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default async function handler(req, res) {
  try {
    const runtime = cloneConfig();
    if (String(req.query?.v5Admin || '') === '1') {
      return await handleV5Admin(req, res);
    }
    if (String(req.query?.runtime || '') === '1') {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
      return res.status(200).json(runtime);
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const courseSlug = req.query.course || 'donut';
    const { data: course, error } = await supabase
      .from('courses')
      .select('*')
      .eq('slug', courseSlug)
      .eq('active', true)
      .single();

    if (error || !course) {
      return res.status(404).json({ error: `Không tìm thấy khóa học hoạt động với slug: ${courseSlug}` });
    }

    const rawData = course.raw_data || {};
    const courseImage = course.image_url || rawData.imageUrl || rawData.posterUrl || rawData.posterImageUrl || rawData.thumbnail || rawData.heroUrl || rawData.heroImageUrl || rawData.coverUrl || '';
    const deliveryMode = normalizeDeliveryMode(course.delivery_mode);
    if (deliveryMode === 'v4' && course.is_published !== true && rawData.v4SellBeforePublishAcknowledged !== true) {
      return res.status(404).json({ error: `Khóa học V4 chưa sẵn sàng với slug: ${courseSlug}` });
    }
    if (deliveryMode === 'v5' && course.is_published !== true) {
      return res.status(404).json({ error: `Khóa học V5 chưa sẵn sàng với slug: ${courseSlug}` });
    }

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
      deliveryMode,
      lmsPublicUrl: runtime.lmsPublicUrl,
      commercePublicUrl: runtime.commercePublicUrl,
      v4PublicUrl: runtime.v4PublicUrl,
      telegramClonerUrl: runtime.telegramClonerUrl,
      legacyPortalPublicUrl: runtime.legacyPortalPublicUrl,
      telegramReady: deliveryMode !== 'telegram' || Boolean(String(course.telegram_chat_id || '').trim())
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
