import { supabase } from "../utils/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Xác thực quyền Admin
  const adminPassword = req.headers["x-admin-password"];
  const systemPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || adminPassword !== systemPassword) {
    return res.status(401).json({ error: "Unauthorized: Mật khẩu Admin không chính xác." });
  }

  try {
    const { course } = req.body;

    if (!course) {
      return res.status(400).json({ error: "Thiếu course slug" });
    }

    // Cập nhật tất cả các đơn hàng của khóa học từ "Chờ duyệt" thành "Đã duyệt"
    // và lấy về danh sách thông tin đơn hàng của học viên vừa được duyệt
    const { data: updatedOrders, error } = await supabase
      .from("orders")
      .update({
        status: "Đã duyệt",
        updated_at: new Date().toISOString()
      })
      .eq("course_slug", course)
      .eq("status", "Chờ duyệt")
      .select("id, customer_email, course_slug");

    if (error) throw error;

    const gmails = (updatedOrders || []).map((o) => o.customer_email).filter(Boolean);

    // Đồng bộ quyền học viên sang các hệ thống ngoại vi
    if (updatedOrders && updatedOrders.length > 0) {
      try {
        const { syncEnrollmentToExternalSystems } = await import("../utils/sync-helpers.js");
        for (const order of updatedOrders) {
          if (!order.customer_email) continue;
          
          const syncResults = await syncEnrollmentToExternalSystems(order, "create");
          
          await supabase
            .from("orders")
            .update({
              sync_lms_status: syncResults.lms,
              sync_portal_status: syncResults.portal,
              sync_error: syncResults.error
            })
            .eq("id", order.id);
        }
      } catch (syncErr) {
        console.error("Bulk approve sync error:", syncErr);
      }
    }

    return res.status(200).json({
      success: true,
      count: gmails.length,
      gmails
    });
  } catch (error) {
    console.error("APPROVE_ALL_ERROR:", error);
    return res.status(500).json({
      error: error.message
    });
  }
}
