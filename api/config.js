import { supabase } from "../utils/supabase.js";
import { warmRuntimeConfig } from "../utils/v2-runtime-controller.js";

export default async function handler(req, res) {
  // Warm the V1/V2 runtime master-switch cache once per request so the
  // synchronous restrict-only gate (isV2ActiveCached) is populated for the
  // rest of the invocation. Never throws; cold-cache fail-open preserves V1.
  await warmRuntimeConfig();

  try {
    const courseSlug = req.query.course || "donut";

    const { data: course, error } = await supabase
      .from("courses")
      .select("*")
      .eq("slug", courseSlug)
      .eq("active", true)
      .single();

    if (error || !course) {
      return res.status(404).json({
        error: `Không tìm thấy khóa học hoạt động với slug: ${courseSlug}`
      });
    }

    const rawData = course.raw_data || {};
    const courseImage =
      course.image_url ||
      rawData.imageUrl ||
      rawData.posterUrl ||
      rawData.posterImageUrl ||
      rawData.thumbnail ||
      rawData.heroUrl ||
      rawData.heroImageUrl ||
      rawData.coverUrl ||
      "";

    // Định dạng cấu hình tương thích ngược hoàn toàn với Google Sheets
    const config = {
      course: course.slug,
      courseName: course.title,
      price: course.price || "",
      imageUrl: courseImage,
      bankName: rawData.bankName || "",
      bankAccount: rawData.bankAccount || "",
      bankOwner: rawData.bankOwner || "",
      transferNote: rawData.transferNote || "",
      qrImageUrl: rawData.qrImageUrl || ""
    };

    return res.status(200).json(config);
  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
