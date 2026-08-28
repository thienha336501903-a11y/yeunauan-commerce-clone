import { supabase } from "../utils/supabase.js";
import { syncV4EnrollmentToLms } from "../utils/v4-sync-helpers.js";
import { approveV5Order, v5SyncFailed } from "../utils/v5-order-approval.js";

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
      .select("id, course_id, customer_email, course_slug, course_title, delivery_mode, status")
      .eq("course_slug", course)
      .eq("status", "Chờ duyệt");
    if (pendingError) throw pendingError;

    const enrollmentOrders = (pendingOrders || []).filter(order => String(order.delivery_mode || '').toLowerCase() !== "telegram");
    const v5Orders = enrollmentOrders.filter(order => String(order.delivery_mode || '').toLowerCase() === 'v5');
    const standardOrders = enrollmentOrders.filter(order => String(order.delivery_mode || '').toLowerCase() !== 'v5');
    const skippedTelegram = (pendingOrders || []).length - enrollmentOrders.length;
    const results = [];
    const approvedOrders = [];

    // V5 is sync-first: an order stays pending if entitlement creation fails.
    // This prevents “Đã duyệt” from being visible while no learner access exists.
    for (const order of v5Orders) {
      try {
        const result = await approveV5Order(order);
        if (!result.ok) {
          results.push({ id: order.id, ok: false, keptPending: true, sync: result.syncResults || { lms: 'FAILED', portal: 'SKIPPED_V5', error: result.error }, code: result.code || 'v5_approval_failed' });
          continue;
        }
        approvedOrders.push(result.data);
        results.push({ id: order.id, ok: !v5SyncFailed(result.syncResults), sync: result.syncResults });
      } catch (syncErr) {
        const message = syncErr?.message || String(syncErr);
        console.error("Bulk approve V5 error:", order.id, message);
        results.push({ id: order.id, ok: false, keptPending: true, sync: { lms: "FAILED", portal: "SKIPPED_V5", error: message }, code: syncErr?.code || 'v5_approval_failed' });
      }
    }

    // Preserve the existing V4/legacy behavior; this change is deliberately
    // isolated to V5 so the stable modes are not refactored during V5 rollout.
    let updatedStandardOrders = [];
    if (standardOrders.length) {
      const { data, error } = await supabase
        .from("orders")
        .update({ status: "Đã duyệt", updated_at: new Date().toISOString() })
        .in("id", standardOrders.map(order => order.id))
        .eq("status", "Chờ duyệt")
        .select("id, course_id, customer_email, course_slug, course_title, delivery_mode");
      if (error) throw error;
      updatedStandardOrders = data || [];
      approvedOrders.push(...updatedStandardOrders);
    }

    for (const order of updatedStandardOrders) {
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

    const gmails = approvedOrders.map(order => order.customer_email).filter(Boolean);
    const syncSucceeded = results.filter(result => result.ok).length;
    const syncFailedCount = results.length - syncSucceeded;
    const v5KeptPending = results.filter(result => result.keptPending).length;

    return res.status(200).json({
      success: true,
      requested: enrollmentOrders.length,
      count: approvedOrders.length,
      gmails,
      skippedTelegram,
      v5KeptPending,
      syncSucceeded,
      syncFailed: syncFailedCount,
      results
    });
  } catch (error) {
    console.error("APPROVE_ALL_ERROR:", error);
    return res.status(500).json({ error: error.message, code: error.code || 'approve_all_error', compensation: error.compensation || null });
  }
}
