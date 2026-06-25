import { supabase } from "../utils/supabase.js";

export default async function handler(req, res) {
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

    // Định dạng cấu hình tương thích ngược hoàn toàn với Google Sheets
    const config = {
      course: course.slug,
      courseName: course.title,
      price: course.price || "",
      imageUrl: course.image_url || "",
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
