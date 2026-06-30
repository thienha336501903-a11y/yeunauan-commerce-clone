import { v2 as cloudinary } from "cloudinary";
import { supabase } from "../utils/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const {
      gmail,
      billName,
      billType,
      billData,
      course,
      courseName
    } = req.body;

    if (!gmail || !billName || !billType || !billData) {
      return res.status(400).json({
        error: "Thiếu dữ liệu"
      });
    }

    const courseSlug = course || "donut";
    const finalCourseName = courseName || courseSlug;

    // Cấu hình Cloudinary
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    // Upload base64 image lên Cloudinary
    const uploadResult = await cloudinary.uploader.upload(
      "data:" + billType + ";base64," + billData,
      {
        folder: "bill-chuyen-khoan/" + courseSlug,
        resource_type: "image"
      }
    );

    const billLink = uploadResult.secure_url;

    // Ghi dữ liệu đơn hàng vào Supabase
    const { error: insertError } = await supabase
      .from("orders")
      .insert({
        course_slug: courseSlug,
        course_title: finalCourseName,
        customer_email: gmail,
        proof_image_url: billLink,
        status: "Chờ duyệt",
        raw_data: {
          billName,
          billType
        }
      });

    if (insertError) {
      throw insertError;
    }

    // Sync pending order to Student Portal (Supabase A)
    const system1Url = process.env.SYSTEM1_URL;
    const syncSecret = process.env.INTERNAL_SYNC_SECRET;
    if (system1Url && syncSecret) {
      try {
        await fetch(`${system1Url.trim().replace(/\/$/, '')}/api/sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Sync-Secret": syncSecret
          },
          body: JSON.stringify({
            action: "syncPendingOrder",
            email: gmail,
            courseSlug: courseSlug
          })
        });
      } catch (syncErr) {
        console.error("Error syncing pending order to Portal:", syncErr);
      }
    }

    return res.status(200).json({
      success: true,
      file: billLink,
      course: courseSlug,
      courseName: finalCourseName
    });
  } catch (error) {
    console.error("REGISTER_ERROR:", error);

    return res.status(500).json({
      error: error.message
    });
  }
}
