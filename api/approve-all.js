import { supabase } from "../utils/supabase.js";
import { syncV4EnrollmentToLms } from "../utils/v4-sync-helpers.js";
import { syncV5EnrollmentToLms } from "../utils/v5-sync-helpers.js";

function syncFailed(syncResults) {
  if (!syncResults) return true;
  const lmsFailed = String(syncResults.lms || "").toUpperCase() === "FAILED";
  const portalFailed = String(syncResults.portal || "").toUpperCase() === "FAILED";
  return lmsFailed || portalFailed || Boolean(syncResults.error);
}

function skippedPortal(mode) {
  if (mode === "v4") return "SKIPPED_V4";
  if (mode === "v5") return "SKIPPED_V5";
  return "FAILED";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const adminPassword = req.headers["x-admin-password"];
  const systemPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword || adminPassword !== systemPassword) return res.status(401).json({ error: "Unauthorized: Mật khẩu Admin không chính xác." });

  try {
    const course = String(req.body?.course || "").trim();
    if (!course) return res.status(400).json({ error: "Thiếu course slug" });
    const { data: pendingOrders, error: pendingError } = await supabase.from("orders").select("id, customer_email, course_slug, course_title, delivery_mode, status").eq("course_slug", course).eq("status", "Chờ duyệt");
    if (pendingError) throw pendingError;
    const enrollmentOrders = (pendingOrders || []).filter(order => order.delivery_mode !== "telegram");
    const skippedTelegram = (pendingOrders || []).length - enrollmentOrders.length;
    let updatedOrders = [];
    if (enrollmentOrders.length) {
      const { data, error } = await supabase.from("orders").update({ status: "Đã duyệt", updated_at: new Date().toISOString() }).in("id", enrollmentOrders.map(order => order.id)).eq("status", "Chờ duyệt").select("id, customer_email, course_slug, course_title, delivery_mode");
      if (error) throw error;
      updatedOrders = data || [];
    }
    const gmails = updatedOrders.map(order => order.customer_email).filter(Boolean);
    const results = [];
    for (const order of updatedOrders) {
      const mode = String(order.delivery_mode || "").toLowerCase();
      if (!order.customer_email) {
        const syncResults = { lms: "FAILED", portal: skippedPortal(mode), error: "Missing customer email" };
        await supabase.from("orders").update({ sync_lms_status: syncResults.lms, sync_portal_status: syncResults.portal, sync_error: syncResults.error }).eq("id", order.id);
        results.push({ id: order.id, ok: false, sync: syncResults });
        continue;
      }
      try {
        let syncResults;
        if (mode === "v4") syncResults = await syncV4EnrollmentToLms(order, "create");
        else if (mode === "v5") syncResults = await syncV5EnrollmentToLms(order, "create");
        else {
          const { syncEnrollmentToExternalSystems } = await import("../utils/sync-helpers.js");
          syncResults = await syncEnrollmentToExternalSystems(order, "create");
        }
        const failed = syncFailed(syncResults);
        const { error: statusError } = await supabase.from("orders").update({ sync_lms_status: syncResults.lms, sync_portal_status: syncResults.portal, sync_error: syncResults.error }).eq("id", order.id);
        if (statusError) throw statusError;
        results.push({ id: order.id, ok: !failed, sync: syncResults });
      } catch (syncErr) {
        const message = syncErr?.message || String(syncErr);
        console.error("Bulk approve sync error:", order.id, message);
        await supabase.from("orders").update({ sync_lms_status: "FAILED", sync_portal_status: skippedPortal(mode), sync_error: message }).eq("id", order.id);
        results.push({ id: order.id, ok: false, sync: { lms: "FAILED", portal: skippedPortal(mode), error: message } });
      }
    }
    const syncSucceeded = results.filter(result => result.ok).length;
    return res.status(200).json({ success: true, count: updatedOrders.length, gmails, skippedTelegram, syncSucceeded, syncFailed: results.length - syncSucceeded, results });
  } catch (error) {
    console.error("APPROVE_ALL_ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
}
