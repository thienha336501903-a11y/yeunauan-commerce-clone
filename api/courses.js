import { supabase } from "../utils/supabase.js";

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Xác thực quyền Admin
  const adminPassword = req.headers["x-admin-password"];
  const systemPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || adminPassword !== systemPassword) {
    return res.status(401).json({ error: "Unauthorized: Mật khẩu Admin không chính xác hoặc trống." });
  }

  try {
    if (req.method === "GET") {
      // Lấy danh sách tất cả khóa học, sắp xếp theo sort_order trước, sau đó là created_at
      const { data: courses, error } = await supabase
        .from("courses")
        .select("*")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Định dạng tương thích ngược
      const formattedCourses = courses.map((c) => ({
        id: c.id,
        slug: c.slug,
        courseName: c.title,
        price: c.price || "",
        imageUrl: c.image_url || "",
        active: c.active,
        sort_order: c.sort_order,
        description: c.description || "",
        teacher_name: c.teacher_name || "",
        is_published: c.is_published === true,
        created_at: c.created_at,
        sync_lms_status: c.sync_lms_status || "PENDING",
        sync_portal_status: c.sync_portal_status || "PENDING",
        sync_error: c.sync_error || "",
        ...(c.raw_data || {})
      }));

      return res.status(200).json(formattedCourses);
    }

    if (req.method === "POST") {
      const {
        slug,
        courseName,
        title,
        price,
        imageUrl,
        active,
        sort_order,
        description,
        teacher_name,
        is_published,
        bankName,
        bankAccount,
        bankOwner,
        transferNote,
        qrImageUrl
      } = req.body;

      if (!slug || (!courseName && !title)) {
        return res.status(400).json({ error: "Thiếu thông tin bắt buộc (slug, title)" });
      }

      const { data, error } = await supabase
        .from("courses")
        .insert({
          slug,
          title: title || courseName,
          price,
          image_url: imageUrl,
          active: active !== undefined ? active : true,
          sort_order: sort_order !== undefined ? parseInt(sort_order, 10) : 0,
          description: description || "",
          teacher_name: teacher_name || "",
          is_published: is_published === true,
          raw_data: {
            bankName: bankName || "",
            bankAccount: bankAccount || "",
            bankOwner: bankOwner || "",
            transferNote: transferNote || "",
            qrImageUrl: qrImageUrl || ""
          }
        })
        .select()
        .single();

      if (error) throw error;

      // Sync to external systems
      let syncResults = { lms: "PENDING", portal: "PENDING", error: null };
      try {
        const { syncCourseToExternalSystems } = await import("../utils/sync-helpers.js");
        syncResults = await syncCourseToExternalSystems({
          slug,
          courseName: title || courseName,
          price,
          imageUrl,
          active,
          teacher_name
        });
        
        // Update database with sync status
        await supabase
          .from("courses")
          .update({
            sync_lms_status: syncResults.lms,
            sync_portal_status: syncResults.portal,
            sync_error: syncResults.error
          })
          .eq("id", data.id);
      } catch (syncErr) {
        console.error("Course sync trigger error:", syncErr);
      }

      return res.status(201).json({ success: true, data: { ...data, syncResults } });
    }

    if (req.method === "PUT") {
      const {
        id,
        slug,
        courseName,
        title,
        price,
        imageUrl,
        active,
        sort_order,
        description,
        teacher_name,
        is_published,
        bankName,
        bankAccount,
        bankOwner,
        transferNote,
        qrImageUrl
      } = req.body;

      if (!id) {
        return res.status(400).json({ error: "Thiếu ID khóa học để cập nhật" });
      }

      const updatePayload = {
        slug,
        title: title || courseName,
        price,
        image_url: imageUrl,
        active: active !== undefined ? active : true,
        sort_order: sort_order !== undefined ? parseInt(sort_order, 10) : 0,
        description: description || "",
        teacher_name: teacher_name || "",
        raw_data: {
          bankName: bankName || "",
          bankAccount: bankAccount || "",
          bankOwner: bankOwner || "",
          transferNote: transferNote || "",
          qrImageUrl: qrImageUrl || ""
        }
      };

      if (is_published !== undefined) {
        updatePayload.is_published = is_published === true;
      }

      const { data, error } = await supabase
        .from("courses")
        .update(updatePayload)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;

      // Sync to external systems
      let syncResults = { lms: "PENDING", portal: "PENDING", error: null };
      try {
        const { syncCourseToExternalSystems } = await import("../utils/sync-helpers.js");
        syncResults = await syncCourseToExternalSystems({
          slug,
          courseName: title || courseName,
          price,
          imageUrl,
          active,
          teacher_name
        });
        
        // Update database with sync status
        await supabase
          .from("courses")
          .update({
            sync_lms_status: syncResults.lms,
            sync_portal_status: syncResults.portal,
            sync_error: syncResults.error
          })
          .eq("id", id);
      } catch (syncErr) {
        console.error("Course sync trigger error:", syncErr);
      }

      return res.status(200).json({ success: true, data: { ...data, syncResults } });
    }

    if (req.method === "DELETE") {
      const { id } = req.body || req.query;

      if (!id) {
        return res.status(400).json({ error: "Thiếu ID khóa học để xóa" });
      }

      const { error } = await supabase
        .from("courses")
        .delete()
        .eq("id", id);

      if (error) throw error;

      return res.status(200).json({ success: true, message: "Đã xóa khóa học thành công" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("COURSES_API_ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
}
