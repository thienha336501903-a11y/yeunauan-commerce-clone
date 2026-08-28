import { supabase } from '../utils/supabase.js';
import { normalizeDeliveryMode } from '../utils/delivery-policy.js';
import { getV5Readiness } from '../utils/v5-readiness.js';

const validSlug = value => /^[a-z0-9_-]+$/.test(String(value || '').trim());

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const adminPassword = req.headers['x-admin-password'];
  if (!adminPassword || adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const slug = String(req.query?.course || req.query?.courseSlug || '').trim();
    if (!validSlug(slug)) return res.status(400).json({ success: false, error: 'Slug khóa học không hợp lệ' });

    const { data: course, error } = await supabase
      .from('courses')
      .select('id,slug,title,delivery_mode,active,is_published')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw error;
    if (!course) return res.status(404).json({ success: false, error: 'Không tìm thấy khóa học' });
    if (normalizeDeliveryMode(course.delivery_mode) !== 'v5') {
      return res.status(409).json({ success: false, error: 'Khóa học không phải LMS V5' });
    }

    const readiness = await getV5Readiness(course.id);
    return res.status(200).json({
      success: true,
      course: {
        id: course.id,
        slug: course.slug,
        title: course.title,
        active: course.active === true,
        is_published: course.is_published === true
      },
      canonicalReady: readiness.ready === true,
      reason: readiness.reason || null,
      release: readiness.release ? {
        id: readiness.release.id,
        version: readiness.release.version,
        status: readiness.release.status,
        created_at: readiness.release.created_at
      } : null,
      canSell: readiness.ready === true && course.active === true && course.is_published === true
    });
  } catch (error) {
    console.error('[v5-readiness]', error);
    return res.status(500).json({ success: false, error: 'Không kiểm tra được trạng thái V5' });
  }
}
