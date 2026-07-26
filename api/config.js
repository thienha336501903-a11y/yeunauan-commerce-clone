import { supabase } from "../utils/supabase.js";
import { warmRuntimeConfig } from "../utils/v2-runtime-controller.js";
import { applyCourseTenantFilter, getDeploymentSalesSite } from "../utils/sales-site.js";
import { fixturePublicCourse, isPreviewFixture } from "../utils/preview-fixture.js";

export default async function handler(req, res) {
  // Warm the V1/V2 runtime master-switch cache once per request so the
  // synchronous restrict-only gate (isV2ActiveCached) is populated for the
  // rest of the invocation. Never throws; cold-cache fail-open preserves V1.
  await warmRuntimeConfig();

  try {
    const courseSlug = req.query.course || "donut";
    if (isPreviewFixture()) {
      const course = fixturePublicCourse(courseSlug);
      if (!course) return res.status(404).json({ error: "Không tìm thấy khóa học" });
      const rawData = course.raw_data || {};
      return res.status(200).json({
        course: course.slug,
        courseName: course.title,
        price: course.price || "",
        imageUrl: course.image_url || "",
        bankName: rawData.bankName || "",
        bankAccount: rawData.bankAccount || "",
        bankOwner: rawData.bankOwner || "",
        transferNote: rawData.transferNote || "",
        qrImageUrl: rawData.qrImageUrl || "",
        previewDeployment: {
          salesSite: getDeploymentSalesSite(),
          publicSiteUrl: String(process.env.PUBLIC_SITE_URL || "").trim().replace(/\/$/, ""),
          dataMode: "fixture",
          externalSyncMode: process.env.EXTERNAL_SYNC_MODE || ""
        }
      });
    }

    const salesSite = getDeploymentSalesSite();
    let query = supabase
      .from("courses")
      .select("*")
      .eq("slug", courseSlug)
      .eq("active", true);
    query = applyCourseTenantFilter(query, salesSite);
    const { data: course, error } = await query.maybeSingle();

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
