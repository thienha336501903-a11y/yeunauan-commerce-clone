import { supabase } from '../utils/supabase.js';
import { normalizeDeliveryMode } from '../utils/delivery-policy.js';
import { cloneConfig } from '../utils/clone-config.js';
import { getV5Readiness } from '../utils/v5-readiness.js';
import { enforceSameOriginAdminRequest } from '../utils/admin-cors.js';
import { isCourseForSale, isSalePaused } from '../utils/sale-state.js';
import { resolveRequestRoute } from '../utils/agency-routing.js';
import { getAgencyCommerceConfig } from '../utils/agency-commerce.js';
import { requireAgencyMembership } from '../utils/agency-auth.js';
import { bridgeGoogleAccessTokenToSupabaseSession } from '../utils/agency-google-auth-bridge.js';

const validSlug = value => /^[a-z0-9_-]+$/.test(String(value || '').trim());

function clearAccessTokenCookie(res) {
  res.setHeader(
    'Set-Cookie',
    'sb-access-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  );
}

async function handleAgencySession(req, res, routeDecision, options = {}) {
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'POST') {
    const bridge = await bridgeGoogleAccessTokenToSupabaseSession(
      req,
      res,
      routeDecision.tenant,
      options
    );
    if (!bridge.ok) {
      return res.status(bridge.status || 401).json({
        success: false,
        code: bridge.code,
        error: bridge.error
      });
    }

    return res.status(200).json({
      success: true,
      userId: bridge.userId,
      membershipId: bridge.membershipId,
      agency: {
        id: routeDecision.tenant.agencyId,
        slug: routeDecision.tenant.agencySlug,
        name: routeDecision.tenant.agencyName
      }
    });
  }

  if (req.method === 'GET') {
    const auth = await requireAgencyMembership(req, options);
    if (!auth.ok) {
      return res.status(auth.status || 401).json({
        success: false,
        code: auth.code,
        error: auth.error
      });
    }

    return res.status(200).json({
      success: true,
      member: {
        id: auth.membership.id,
        userId: auth.user.id,
        email: auth.user.email || '',
        displayName: auth.membership.display_name || '',
        role: auth.membership.role,
        status: auth.membership.status
      },
      agency: {
        id: auth.tenant.agencyId,
        slug: auth.tenant.agencySlug,
        name: auth.tenant.agencyName
      }
    });
  }

  if (req.method === 'DELETE') {
    clearAccessTokenCookie(res);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({
    success: false,
    code: 'method_not_allowed',
    error: 'Method not allowed.'
  });
}

async function handleV5AdminReadiness(req, res) {
  if (!enforceSameOriginAdminRequest(req, res, ['GET', 'OPTIONS'])) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const adminPassword = req.headers['x-admin-password'];
  if (!adminPassword || adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const slug = String(req.query?.course || req.query?.courseSlug || '').trim();
  if (!validSlug(slug)) return res.status(400).json({ success: false, error: 'Slug khóa học không hợp lệ' });

  const { data: course, error } = await supabase
    .from('courses')
    .select('id,slug,title,delivery_mode,active,is_published,raw_data')
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
      is_published: course.is_published === true,
      salePaused: isSalePaused(course)
    },
    canonicalReady: readiness.ready === true,
    reason: readiness.reason || null,
    release: readiness.release ? {
      id: readiness.release.id,
      version: readiness.release.version,
      status: readiness.release.status,
      created_at: readiness.release.created_at
    } : null,
    canSell: isCourseForSale(course)
  });
}

export default async function handler(req, res) {
  // Phase 5B: Host dispatch before running legacy handler
  const options = req.__options || {};
  const routeDecision = await resolveRequestRoute(req, options);
  if (routeDecision.route === "DENY") {
    return res.status(routeDecision.status || 403).json({ error: routeDecision.error, code: routeDecision.code });
  }
  if (routeDecision.route === "AGENCY") {
    if (String(req.query?.agencySession || '') === '1') {
      return handleAgencySession(req, res, routeDecision, options);
    }

    const configResult = await getAgencyCommerceConfig(req, options);
    if (!configResult.ok) {
      return res.status(configResult.status || 500).json({ error: configResult.error, code: configResult.code });
    }
    const runtime = cloneConfig();
    return res.status(200).json({
      success: true,
      agency: configResult.agency,
      banks: configResult.banks,
      offerings: configResult.offerings,
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      lmsPublicUrl: runtime.lmsPublicUrl
    });
  }
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
    if (isSalePaused(course)) {
      return res.status(404).json({ error: `Khóa học đang tạm dừng nhận đăng ký với slug: ${courseSlug}`, code: 'sale_paused' });
    }
    const courseImage = course.image_url || rawData.imageUrl || rawData.posterUrl || rawData.posterImageUrl || rawData.thumbnail || rawData.heroUrl || rawData.heroImageUrl || rawData.coverUrl || '';
    const deliveryMode = normalizeDeliveryMode(course.delivery_mode);
    if (deliveryMode === 'v4' && course.is_published !== true && rawData.v4SellBeforePublishAcknowledged !== true) {
      return res.status(404).json({ error: `Khóa học V4 chưa sẵn sàng với slug: ${courseSlug}` });
    }
    if (deliveryMode === 'v5') {
      if (course.is_published === true) {
        const readiness = await getV5Readiness(course.id);
        if (!readiness.ready) {
          console.warn('[config] V5 storefront blocked by canonical readiness:', courseSlug, readiness.reason);
          return res.status(404).json({ error: `Khóa học V5 chưa sẵn sàng với slug: ${courseSlug}` });
        }
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
      telegramReady: deliveryMode !== 'telegram' || Boolean(String(course.telegram_chat_id || '').trim())
    });
  } catch (error) {
    console.error('[config]', error);
    return res.status(500).json({ error: error.message });
  }
}
