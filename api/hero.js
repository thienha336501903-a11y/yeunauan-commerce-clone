import { supabase } from "../utils/supabase.js";

const DEFAULT_PLACEHOLDER = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1100" viewBox="0 0 900 1100"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff7ed"/><stop offset="1" stop-color="#fce7f3"/></linearGradient></defs><rect width="900" height="1100" fill="url(#bg)"/><circle cx="730" cy="150" r="150" fill="#f9a8d4" opacity=".28"/><circle cx="170" cy="930" r="180" fill="#fb923c" opacity=".18"/><rect x="220" y="365" width="460" height="300" rx="54" fill="#fff" opacity=".84"/><path d="M300 590l85-104 75 77 58-62 118 94" fill="none" stroke="#b65c4b" stroke-width="28" stroke-linecap="round" stroke-linejoin="round" opacity=".78"/><circle cx="560" cy="444" r="36" fill="#b65c4b" opacity=".68"/><text x="450" y="760" text-anchor="middle" font-family="Arial,sans-serif" font-size="46" font-weight="800" fill="#241712">Ảnh khóa học</text></svg>`
);

function getGoogleDriveFileId(input) {
  const url = String(input || '').trim();
  let m = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  if (m) return m[1];
  m = url.match(/[?&]id=([^&#]+)/);
  if (m) return m[1];
  m = url.match(/drive\.google\.com\/open\?id=([^&#]+)/);
  return m ? m[1] : '';
}

function normalizeImageUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  const id = getGoogleDriveFileId(value);
  return id ? `https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}` : value;
}

export default async function handler(req, res) {
  try {
    const courseSlug = req.query.course || "donut";

    const { data: course, error } = await supabase
      .from("courses")
      .select("image_url, raw_data")
      .eq("slug", courseSlug)
      .eq("active", true)
      .single();

    if (error || !course) {
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
      return res.redirect(302, DEFAULT_PLACEHOLDER);
    }

    const rawData = course.raw_data || {};
    const rawImage =
      course.image_url ||
      rawData.imageUrl ||
      rawData.posterUrl ||
      rawData.posterImageUrl ||
      rawData.thumbnail ||
      rawData.heroUrl ||
      rawData.heroImageUrl ||
      rawData.coverUrl ||
      "";

    const normalizedImage = normalizeImageUrl(rawImage) || DEFAULT_PLACEHOLDER;

    // Cache-Control: Edge cache trong 5 phút, stale-while-revalidate 10 phút
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return res.redirect(302, normalizedImage);
  } catch (err) {
    res.setHeader("Cache-Control", "no-cache");
    return res.redirect(302, DEFAULT_PLACEHOLDER);
  }
}
