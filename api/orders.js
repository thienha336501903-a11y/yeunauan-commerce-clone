import { supabase } from "../utils/supabase.js";
import { warmRuntimeConfig } from "../utils/v2-runtime-controller.js";

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Warm the V1/V2 runtime master-switch cache once per request so the
  // synchronous restrict-only gate (isV2ActiveCached) is populated for the
  // rest of the invocation. Never throws; cold-cache fail-open preserves V1.
  await warmRuntimeConfig();

  // Xác thực quyền Admin
  const adminPassword = req.headers["x-admin-password"];
  const systemPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || adminPassword !== systemPassword) {
    return res.status(401).json({ error: "Unauthorized: Mật khẩu Admin không chính xác hoặc trống." });
  }

  try {
    if (req.method === "GET") {
      const { data: orders, error } = await supabase
        .from("orders")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Trả về danh sách đơn hàng đã format tương thích ngược cả tiếng Việt và tiếng Anh
      const formattedOrders = orders.map((o) => {
        const timeFormatted = new Date(o.created_at).toLocaleString("vi-VN", {
          timeZone: "Asia/Ho_Chi_Minh"
        });

        return {
          id: o.id,
          created_at: o.created_at,
          "Thời gian": timeFormatted,
          time: timeFormatted,
          "Course": o.course_slug,
          course: o.course_slug,
          "Tên khóa học": o.course_title,
          courseName: o.course_title,
          "Gmail": o.customer_email,
          gmail: o.customer_email,
          "Link bill": o.proof_image_url,
          billLink: o.proof_image_url,
          "Trạng thái": o.status,
          status: o.status,
          note: o.note || "",
          customer_phone: o.customer_phone || "",
          customer_name: o.customer_name || "",
          sync_lms_status: o.sync_lms_status || "PENDING",
          sync_portal_status: o.sync_portal_status || "PENDING",
          sync_error: o.sync_error || "",
          ...(o.raw_data || {})
        };
      });

      return res.status(200).json(formattedOrders);
    }

    if (req.method === "PUT") {
      const { id, status, note, customer_name, customer_phone, gmail, action } = req.body;

      if (!id) {
        return res.status(400).json({ error: "Thiếu ID đơn hàng để cập nhật" });
      }

      // Manual resync action
      if (action === "resync") {
        const { data: order, error: fetchErr } = await supabase
          .from("orders")
          .select("*")
          .eq("id", id)
          .maybeSingle();

        if (fetchErr) throw fetchErr;
        if (!order) {
          return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
        }

        const { syncEnrollmentToExternalSystems } = await import("../utils/sync-helpers.js");
        const actionType = order.status === "Đã duyệt" ? "create" : "revoke";
        const syncResults = await syncEnrollmentToExternalSystems(order, actionType);

        // Update database with sync status
        const { data: updatedOrder, error: updateErr } = await supabase
          .from("orders")
          .update({
            sync_lms_status: syncResults.lms,
            sync_portal_status: syncResults.portal,
            sync_error: syncResults.error
          })
          .eq("id", id)
          .select()
          .single();

        if (updateErr) throw updateErr;
        return res.status(200).json({ success: true, data: { ...updatedOrder, syncResults } });
      }

      // Standard update
      const updateData = {
        updated_at: new Date().toISOString()
      };
      
      if (status !== undefined) updateData.status = status;
      if (note !== undefined) updateData.note = note;
      if (customer_name !== undefined) updateData.customer_name = customer_name;
      if (customer_phone !== undefined) updateData.customer_phone = customer_phone;
      if (gmail !== undefined) {
        const validatedGmail = validateGmail(gmail);
        if (!validatedGmail) {
          return res.status(400).json({ error: "Địa chỉ email không hợp lệ (không được để trống, chứa khoảng trắng, chứa ký tự đặc biệt hoặc ký tự tiếng Việt có dấu)" });
        }
        updateData.customer_email = validatedGmail;
      }

      const { data, error } = await supabase
        .from("orders")
        .update(updateData)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;

      // Sync to external systems if status has changed
      let syncResults = null;
      let updatedData = { ...data };
      if (status !== undefined) {
        try {
          const { syncEnrollmentToExternalSystems } = await import("../utils/sync-helpers.js");
          const actionType = status === "Đã duyệt" ? "create" : "revoke";
          syncResults = await syncEnrollmentToExternalSystems(data, actionType);

          // Update database with sync status and get the updated record
          const { data: finalData } = await supabase
            .from("orders")
            .update({
              sync_lms_status: syncResults.lms,
              sync_portal_status: syncResults.portal,
              sync_error: syncResults.error
            })
            .eq("id", id)
            .select()
            .single();
          
          if (finalData) updatedData = finalData;
        } catch (syncErr) {
          console.error("Order sync trigger error:", syncErr);
        }
      }

      return res.status(200).json({ success: true, data: { ...updatedData, syncResults } });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("ORDERS_API_ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
}

function validateGmail(email) {
  if (!email || typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return null;
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmed)) return null;
  
  if (/\s/.test(trimmed)) return null;
  
  if (/[^\x00-\x7F]/.test(trimmed)) return null;
  
  return trimmed;
}
