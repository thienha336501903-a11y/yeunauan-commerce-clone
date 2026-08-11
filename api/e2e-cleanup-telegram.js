import { v2 as cloudinary } from 'cloudinary';
import { supabase } from '../utils/supabase.js';
import { telegramApi } from '../utils/telegram.js';

const TEST_ORDER_ID = 'd48d3c00-b07b-4938-a075-306ba5606577';
const TEST_COURSE_ID = 'b1480de2-f4e9-4214-acd0-02d43a842076';
const TEST_PREFIX = '__clone_factory_test';

function cloudinaryPublicIdFromUrl(value) {
  const url = new URL(String(value || ''));
  const marker = '/upload/';
  const idx = url.pathname.indexOf(marker);
  if (idx < 0) return '';
  let path = url.pathname.slice(idx + marker.length);
  path = path.replace(/^v\d+\//, '');
  return path.replace(/\.[A-Za-z0-9]+$/, '');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (process.env.VERCEL_ENV === 'production') return res.status(403).json({ error: 'Preview only' });

  try {
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', TEST_ORDER_ID)
      .maybeSingle();
    if (orderError) throw orderError;

    if (!order) {
      return res.status(200).json({ success: true, alreadyCleaned: true });
    }

    if (!String(order.customer_email || '').startsWith(TEST_PREFIX) || !String(order.course_slug || '').startsWith(TEST_PREFIX)) {
      return res.status(409).json({ error: 'Refusing cleanup: target is not prefixed test data' });
    }

    let inviteRevoked = false;
    if (order.telegram_chat_id && order.telegram_invite_link) {
      try {
        await telegramApi('revokeChatInviteLink', {
          chat_id: String(order.telegram_chat_id),
          invite_link: String(order.telegram_invite_link)
        });
        inviteRevoked = true;
      } catch (error) {
        const msg = String(error.message || error);
        if (!/expired|revoked|not found|invite_hash/i.test(msg)) throw error;
      }
    }

    let billRemoved = false;
    const publicId = cloudinaryPublicIdFromUrl(order.proof_image_url);
    if (publicId) {
      const missing = ['CLOUDINARY_CLOUD_NAME','CLOUDINARY_API_KEY','CLOUDINARY_API_SECRET'].filter(k => !process.env[k]);
      if (missing.length) throw new Error('Missing Cloudinary runtime config');
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
      });
      const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
      if (!['ok', 'not found'].includes(String(result.result))) throw new Error('Cloudinary destroy failed: ' + result.result);
      billRemoved = true;
    }

    const { error: deleteOrderError } = await supabase.from('orders').delete().eq('id', TEST_ORDER_ID);
    if (deleteOrderError) throw deleteOrderError;

    const { data: course, error: courseError } = await supabase.from('courses').select('id,slug').eq('id', TEST_COURSE_ID).maybeSingle();
    if (courseError) throw courseError;
    if (course) {
      if (!String(course.slug || '').startsWith(TEST_PREFIX)) return res.status(409).json({ error: 'Refusing course cleanup: not test-prefixed' });
      const { error: deleteCourseError } = await supabase.from('courses').delete().eq('id', TEST_COURSE_ID);
      if (deleteCourseError) throw deleteCourseError;
    }

    return res.status(200).json({ success: true, inviteRevoked, billRemoved, orderDeleted: true, courseDeleted: Boolean(course) });
  } catch (error) {
    console.error('E2E_TELEGRAM_CLEANUP_ERROR:', error);
    return res.status(500).json({ error: error.message || String(error) });
  }
}
