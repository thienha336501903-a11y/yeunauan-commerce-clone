import { supabase } from "../utils/supabase.js";
import { syncV4EnrollmentToLms } from "../utils/v4-sync-helpers.js";

function syncFailed(syncResults) {
  if (!syncResults) return true;
  const lmsFailed = String(syncResults.lms || "").toUpperCase() === "FAILED";
  const portalFailed = String(syncResults.portal || "").toUpperCase() === "FAILED";
  return lmsFailed || portalFailed || Boolean(syncResults.error);
}

function skippedPortalForMode(mode) {
  const normalized = String(mode || "").toLowerCase();
  if (normalized === "v4") return "SKIPPED_V4";
  if (normalized === "v5") return "SKIPPED_V5";
  return "FAILED";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const adminPassword = req.headers["x-admin-password"];
  const systemPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword || adminPassword !== systemPassword) {
    return res.status(401).json({ error: "Unauthorized: Mật khẩu Admin không chính xác." });
  }

  try {
    const course = String(req.body?.course || "").trim();
    if (!course) return res.status(400).json({ error: "Thiếu course slug" });

    const { data: pendingOrders, error: pendingError } = await supabase
      .from("orders")
      .select("id, customer_email, course_slug, course_title, delivery_mode, status")
      .eq("course_slug", course)
      .eq("status", "Chờ duyệt");
    if (pendingError) throw pendingError;

    const enrollmentOrders = (pendingOrders || []).filter(order => order.delivery_mode !== "telegram");
    const skippedTelegram = (pendingOrders || []).length - enrollmentOrders.length;

    let updatedOrders = [];
    if (enrollmentOrders.length) {
      const { data, error } = await supabase
        .from("orders")
        .update({ status: "Đã duyệt", updated_at: new Date().toISOString() })
        .in("id", enrollmentOrders.map(order => order.id))
        .eq("status", "Chờ duyệt")
        .select("id, customer_email, course_slug, course_title, delivery_mode");
      if (error) throw error;
      updatedOrders = data || [];
    }

    const gmails = updatedOrders.map(order => order.customer_email).filter(Boolean);
    const results = [];

    for (const order of updatedOrders) {
      if (!order.customer_email) {
        const syncResults = {
          lms: "FAILED",
          portal: skippedPortalForMode(order.delivery_mode),
          error: "Missing customer email"
        };
        await supabase.from("orders").update({
          sync_lms_status: syncResults.lms,
          sync_portal_status: syncResults.portal,
          sync_error: syncResults.error
        }).eq("id", order.id);
        results.push({ id: order.id, ok: false, sync: syncResults });
        continue;
      }

      try {
        let syncResults;
        if (String(order.delivery_mode || "").toLowerCase() === "v4") {
          syncResults = await syncV4EnrollmentToLms(order, "create");
        } else {
          // Generic helper detects V5 and delegates to /api/v5-sync,
          // while legacy LMS remains unchanged for delivery_mode=lms.
          const { syncEnrollmentToExternalSystems } = await import("../utils/sync-helpers.js");
          syncResults = await syncEnrollmentToExternalSystems(order, "create");
        }

        const failed = syncFailed(syncResults);
        const { error: statusError } = await supabase.from("orders").update({
          sync_lms_status: syncResults.lms,
          sync_portal_status: syncResults.portal,
          sync_error: syncResults.error
        }).eq("id", order.id);
        if (statusError) throw statusError;
        results.push({ id: order.id, ok: !failed, sync: syncResults });
      } catch (syncErr) {
        const message = syncErr?.message || String(syncErr);
        console.error("Bulk approve sync error:", order.id, message);
        const portal = skippedPortalForMode(order.delivery_mode);
        await supabase.from("orders").update({
          sync_lms_status: "FAILED",
          sync_portal_status: portal,
          sync_error: message
        }).eq("id", order.id);
        results.push({ id: order.id, ok: false, sync: { lms: "FAILED", portal, error: message } });
      }
    }

    const syncSucceeded = results.filter(result => result.ok).length;
    const syncFailedCount = results.length - syncSucceeded;

    return res.status(200).json({
      success: true,
      count: updatedOrders.length,
      gmails,
      skippedTelegram,
      syncSucceeded,
      syncFailed: syncFailedCount,
      results
    });
  } catch (error) {
    console.error("APPROVE_ALL_ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
}
