import { v2 as cloudinary } from "cloudinary";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function missingCloudinaryEnv() {
  return ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]
    .filter((name) => !process.env[name]);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const adminPassword = req.headers["x-admin-password"];
  const systemPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || adminPassword !== systemPassword) {
    return res.status(401).json({ error: "Unauthorized: Mat khau Admin khong chinh xac hoac trong." });
  }

  try {
    const { fileData, fileType, fileName, folder } = req.body || {};

    if (!fileData || !fileType) {
      return res.status(400).json({ error: "Thieu du lieu file upload." });
    }

    if (!ALLOWED_IMAGE_TYPES.has(fileType)) {
      return res.status(400).json({
        error: "Dinh dang anh khong duoc ho tro. Chi nhan JPG, PNG, WEBP hoac GIF."
      });
    }

    const cleanBase64 = String(fileData).includes(";base64,")
      ? String(fileData).split(";base64,")[1]
      : String(fileData);
    const byteLength = Buffer.byteLength(cleanBase64, "base64");

    if (!byteLength) {
      return res.status(400).json({ error: "File anh rong hoac du lieu base64 khong hop le." });
    }

    if (byteLength > MAX_IMAGE_BYTES) {
      return res.status(413).json({
        error: `Anh qua lon (${(byteLength / 1024 / 1024).toFixed(1)} MB). Toi da 8 MB.`
      });
    }

    const missingEnv = missingCloudinaryEnv();
    if (missingEnv.length) {
      console.error("UPLOAD_CONFIG_ERROR: Missing Cloudinary env:", missingEnv.join(", "));
      return res.status(500).json({
        error: `Thieu cau hinh Cloudinary tren server: ${missingEnv.join(", ")}`
      });
    }

    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    const uploadResult = await cloudinary.uploader.upload(
      `data:${fileType};base64,${cleanBase64}`,
      {
        folder: folder === "payment-proofs" ? "payment-proofs" : "course-images",
        resource_type: "image",
        use_filename: false,
        unique_filename: true,
        context: fileName ? { original_filename: String(fileName).slice(0, 120) } : undefined,
        overwrite: false
      }
    );

    return res.status(200).json({
      success: true,
      url: uploadResult.secure_url
    });
  } catch (error) {
    console.error("UPLOAD_ERROR:", {
      message: error.message,
      http_code: error.http_code,
      name: error.name
    });
    return res.status(500).json({
      error: error.message || "Upload anh that bai tren server."
    });
  }
}
