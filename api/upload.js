import { v2 as cloudinary } from "cloudinary";

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  // Verification of Admin permission
  const adminPassword = req.headers["x-admin-password"];
  const systemPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || adminPassword !== systemPassword) {
    return res.status(401).json({ error: "Unauthorized: Mật khẩu Admin không chính xác hoặc trống." });
  }

  try {
    const { fileData, fileType } = req.body;

    if (!fileData || !fileType) {
      return res.status(400).json({
        error: "Thiếu dữ liệu file"
      });
    }

    // Cloudinary configuration
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    // Upload base64 image to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(
      "data:" + fileType + ";base64," + fileData,
      {
        folder: "course-images",
        resource_type: "image"
      }
    );

    return res.status(200).json({
      success: true,
      url: uploadResult.secure_url
    });
  } catch (error) {
    console.error("UPLOAD_ERROR:", error);
    return res.status(500).json({
      error: error.message
    });
  }
}
