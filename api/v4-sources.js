import { supabase } from '../utils/supabase.js';

const validSlug = value => /^[a-z0-9_-]+$/.test(String(value || '').trim());
const validUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());

function requireAdmin(req, res) {
  const supplied = String(req.headers['x-admin-password'] || '');
  const expected = String(process.env.ADMIN_PASSWORD || '');
  if (!expected || supplied !== expected) {
    res.status(401).json({ error: 'Unauthorized: Mật khẩu Admin không chính xác hoặc trống.' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAdmin(req, res)) return;

  try {
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

      const current = courseSlug ? (mappings || []).find(row => row.course_slug === courseSlug) || null : null;
      return res.status(200).json({
        success: true,
        courseSlug: courseSlug || null,
        mapping: current,
        sources: (sources || []).map(source => ({
          ...source,
          mappedCourses: mappedCoursesBySource.get(source.id) || [],
          ready: Number(source.indexed_message_count || 0) > 0
        }))
      });
    }

    if (req.method === 'POST') {
      const courseSlug = String(req.body?.courseSlug || '').trim();
      const sourceId = String(req.body?.sourceId || '').trim();
      if (!validSlug(courseSlug)) return res.status(400).json({ error: 'Slug khóa học không hợp lệ' });
      if (!validUuid(sourceId)) return res.status(400).json({ error: 'Nguồn Telegram không hợp lệ' });

      const [{ data: course, error: courseError }, { data: source, error: sourceError }] = await Promise.all([
        supabase.from('courses').select('id,slug,title,delivery_mode').eq('slug', courseSlug).maybeSingle(),
        supabase.from('tgcloner_sources').select('id,chat_id,title,username,active,indexed_at,indexed_message_count').eq('id', sourceId).maybeSingle()
      ]);
      if (courseError) throw courseError;
      if (sourceError) throw sourceError;
      if (!course) return res.status(404).json({ error: 'Không tìm thấy khóa học' });
      if (String(course.delivery_mode || '').toLowerCase() !== 'v4') return res.status(409).json({ error: 'Chỉ khóa Học trên V4 Web mới được gắn nguồn V4' });
      if (!source) return res.status(404).json({ error: 'Không tìm thấy nguồn Telegram đã đăng ký' });

      const payload = {
        course_slug: courseSlug,
        source_id: sourceId,
        enabled: true,
        media_mode: 'telegram_bot_poc',
        updated_at: new Date().toISOString()
      };
      const { data: mapping, error } = await supabase
        .from('lms_v4_telegram_course_sources')
        .upsert(payload, { onConflict: 'course_slug' })
        .select('course_slug,source_id,enabled,media_mode,created_at,updated_at')
        .single();
      if (error) throw error;

      return res.status(200).json({ success: true, mapping, source: { ...source, ready: Number(source.indexed_message_count || 0) > 0 } });
    }

    if (req.method === 'DELETE') {
      const courseSlug = String(req.body?.courseSlug || req.query?.courseSlug || '').trim();
      if (!validSlug(courseSlug)) return res.status(400).json({ error: 'Slug khóa học không hợp lệ' });
      const { error } = await supabase.from('lms_v4_telegram_course_sources').delete().eq('course_slug', courseSlug);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('V4_SOURCES_API_ERROR:', error);
    return res.status(500).json({ error: 'Không thể xử lý nguồn nội dung V4' });
  }
}
