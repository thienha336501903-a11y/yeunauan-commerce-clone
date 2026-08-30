import { supabase } from '../utils/supabase.js';
import { normalizeDeliveryMode } from '../utils/delivery-policy.js';
import { cloneConfig } from '../utils/clone-config.js';
import { getV5Readiness } from '../utils/v5-readiness.js';

const validSlug = value => /^[a-z0-9_-]+$/.test(String(value || '').trim());

async function handleV5AdminReadiness(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const adminPassword = req.headers['x-admin-password'];
  if (!adminPassword || adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

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
}

export default async function handler(req, res) {
  try {
    const runtime = cloneConfig();
    if (String(req.query?.adminReadiness || '') === '1') {
      return await handleV5AdminReadiness(req, res);
    }
    if (String(req.query?.runtime || '') === '1') {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
      return res.status(200).json(runtime);
    }
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
    if (deliveryMode === 'v5') {
      if (course.is_published !== true) {
        return res.status(404).json({ error: `Khóa học V5 chưa Publish với slug: ${courseSlug}` });
      }
      const readiness = await getV5Readiness(course.id);
      if (!readiness.ready) {
        console.warn('[config] V5 storefront blocked by canonical readiness:', courseSlug, readiness.reason);
        return res.status(404).json({ error: `Khóa học V5 chưa sẵn sàng với slug: ${courseSlug}` });
      }
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
    console.error('[config]', error);
    return res.status(500).json({ error: error.message });
  }
}
