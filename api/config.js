import { supabase } from '../utils/supabase.js';
import { normalizeDeliveryMode } from '../utils/delivery-policy.js';

export default async function handler(req, res) {
  try {
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
      telegramReady: deliveryMode !== 'telegram' || Boolean(String(course.telegram_chat_id || '').trim())
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
