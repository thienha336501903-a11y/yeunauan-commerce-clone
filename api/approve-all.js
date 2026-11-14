import { supabase } from "../utils/supabase.js";
import { syncV4EnrollmentToLms } from "../utils/v4-sync-helpers.js";
import { approveV5Order, v5SyncFailed } from "../utils/v5-order-approval.js";
import { enforceSameOriginAdminRequest } from "../utils/admin-cors.js";
import { noticeForApproved } from "../utils/messenger/notify.js";

// C1-1-cap: Workers Free allows 50 subrequests per request. One V5 approval uses 5 (course, config, release,
// LMS sync, order update) and its Messenger notice 2 more: 1 + 6 x 7 = 43. The worst path (order write lost a
// race, then compensation) is 8 per order: 1 + 6 x 8 = 49. The page calls again for the rest.
// shortcut: legacy and V4 orders are still approved in one request with no cap, split them the same way if a legacy class grows past ~20 pending orders.
const V5_BATCH_LIMIT = 6;

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
  if (!enforceSameOriginAdminRequest(req, res, ["POST", "OPTIONS"])) return;
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
    // C1-1-cap: `skip` holds the ids this bulk run already tried, so a run moves past orders that stay pending.
    const skip = new Set(Array.isArray(req.body?.skip) ? req.body.skip.slice(0, 1000).map(String) : []);
    const todo = enrollmentOrders.filter(order => !skip.has(String(order.id)));
    const v5Orders = todo.filter(order => String(order.delivery_mode || '').toLowerCase() === 'v5').slice(0, V5_BATCH_LIMIT);
    // Legacy and V4 orders wait for the request that has no V5 order left, so they never share its budget.
    const standardOrders = v5Orders.length ? [] : todo.filter(order => String(order.delivery_mode || '').toLowerCase() !== 'v5');
    const remaining = todo.length - v5Orders.length - standardOrders.length;
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
        // C1-1: Facebook buyers get the same notice as a single approval; it can only add a warning.
        const { notice, saved } = await noticeForApproved(supabase, { ...order, ...result.data });
        const sync = notice ? { ...result.syncResults, messenger: notice.status, messengerNoticeSaved: saved } : result.syncResults;
        results.push({ id: order.id, ok: !v5SyncFailed(result.syncResults), sync });
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
    const noticed = results.filter(result => result.sync?.messenger);
    const messengerNotified = noticed.filter(result => result.sync.messenger === "sent").length;
    const messengerNeedsHand = noticed.length - messengerNotified;
    const messengerNoticeUnsaved = noticed.filter(result => result.sync.messengerNoticeSaved !== true).length;

    return res.status(200).json({
      success: true,
      requested: enrollmentOrders.length,
      remaining,
      count: approvedOrders.length,
      gmails,
      skippedTelegram,
      v5KeptPending,
      syncSucceeded,
      syncFailed: syncFailedCount,
      messengerNotified,
      messengerNeedsHand,
      messengerNoticeUnsaved,
      results
    });
  } catch (error) {
    console.error("APPROVE_ALL_ERROR:", error);
    return res.status(500).json({ error: error.message, code: error.code || 'approve_all_error', compensation: error.compensation || null });
  }
}
