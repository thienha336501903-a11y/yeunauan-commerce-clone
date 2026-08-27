import crypto from "node:crypto";
import { supabase } from "../utils/supabase.js";
import { syncV4EnrollmentToLms } from "../utils/v4-sync-helpers.js";
import { syncV5CourseToLms } from "../utils/v5-sync-helpers.js";
import ordersHandler from "./orders.js";

const V5_E2E_LMS_PREVIEW = "https://yeunauan-lms-clone-bpyhy6quf.vercel.app";
const V5_E2E_PREFIX = "__clone_factory_test_v5_cross_repo_";

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

function mockResponse() {
  const state = { statusCode: 200, body: null, headers: {} };
  return {
    state,
    setHeader(name, value) { state.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { state.statusCode = code; return this; },
    json(body) { state.body = body; return this; },
    end() { return this; }
  };
}

async function invoke(handler, req) {
  const res = mockResponse();
  await handler(req, res);
  return res.state;
}

async function approveCourse(course) {
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

  return {
    success: true,
    count: updatedOrders.length,
    gmails,
    skippedTelegram,
    syncSucceeded,
    syncFailed: syncFailedCount,
    results
  };
}

async function runV5PreviewE2E() {
  const suffix = crypto.randomBytes(6).toString("hex");
  const slug = `clone-factory-test-v5-${suffix}`;
  const title = `${V5_E2E_PREFIX}${suffix}`;
  const email = `${V5_E2E_PREFIX}${suffix}@example.com`;
  const orderId = crypto.randomUUID();
  const previousTarget = process.env.V5_LMS_SYNC_URL;
  const checks = [];
  const check = (name, ok, detail = null) => {
    checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) throw new Error(`CHECK_FAILED:${name}${detail ? ":" + detail : ""}`);
  };

  try {
    process.env.V5_LMS_SYNC_URL = V5_E2E_LMS_PREVIEW;

    const courseSync = await syncV5CourseToLms({
      slug,
      courseName: title,
      description: "Temporary isolated V5 cross-repo E2E fixture",
      active: true
    });
    check("syncCourse_to_LMS_V5_preview", courseSync.lms === "SUCCESS" && courseSync.portal === "SKIPPED_V5", JSON.stringify(courseSync));

    const { data: course, error: courseError } = await supabase.from("courses").select("id,slug,delivery_mode").eq("slug", slug).single();
    if (courseError) throw courseError;
    check("course_is_v5", String(course.delivery_mode).toLowerCase() === "v5");

    const now = new Date().toISOString();
    const { error: publishError } = await supabase.from("courses").update({ active: true, is_published: true, updated_at: now }).eq("id", course.id);
    if (publishError) throw publishError;
    const { error: configError } = await supabase.from("v5_course_configs").upsert({ course_id: course.id, source_mode: "direct", status: "published", updated_at: now }, { onConflict: "course_id" });
    if (configError) throw configError;

    const { error: orderError } = await supabase.from("orders").insert({
      id: orderId,
      course_id: course.id,
      course_slug: slug,
      course_title: title,
      customer_email: email,
      proof_image_url: "https://example.com/test-only.png",
      status: "Chờ duyệt",
      delivery_mode: "v5",
      raw_data: { billName: `${V5_E2E_PREFIX}${suffix}.png`, probe: true }
    });
    if (orderError) throw orderError;

    const approved = await approveCourse(slug);
    check("bulk_approve_count_1", approved.count === 1, JSON.stringify(approved));
    check("bulk_approve_sync_success", approved.syncSucceeded === 1 && approved.syncFailed === 0, JSON.stringify(approved));

    const { data: orderAfterApprove, error: readOrderError } = await supabase.from("orders").select("status,sync_lms_status,sync_portal_status,sync_error").eq("id", orderId).single();
    if (readOrderError) throw readOrderError;
    check("order_approved", orderAfterApprove.status === "Đã duyệt", JSON.stringify(orderAfterApprove));
    check("order_v5_sync_status", orderAfterApprove.sync_lms_status === "SUCCESS" && orderAfterApprove.sync_portal_status === "SKIPPED_V5", JSON.stringify(orderAfterApprove));

    let { data: enrollment, error: enrollmentError } = await supabase.from("student_enrollments").select("status,source_system,source_order_id,expired_at").eq("email", email).eq("course_slug", slug).single();
    if (enrollmentError) throw enrollmentError;
    check("enrollment_active", enrollment.status === "active", JSON.stringify(enrollment));
    check("enrollment_source_commerce_v5", enrollment.source_system === "commerce_v5" && enrollment.source_order_id === orderId, JSON.stringify(enrollment));

    const adminHeaders = { "x-admin-password": process.env.ADMIN_PASSWORD };
    const resyncApproved = await invoke(ordersHandler, { method: "PUT", headers: adminHeaders, body: { id: orderId, action: "resync" } });
    check("approved_resync_http_200", resyncApproved.statusCode === 200, JSON.stringify(resyncApproved.body));
    check("approved_resync_success", resyncApproved.body?.data?.syncResults?.lms === "SUCCESS" && resyncApproved.body?.data?.syncResults?.portal === "SKIPPED_V5", JSON.stringify(resyncApproved.body));

    const revoke = await invoke(ordersHandler, { method: "PUT", headers: adminHeaders, body: { id: orderId, status: "Từ chối", note: "temporary V5 E2E revoke" } });
    check("revoke_http_200", revoke.statusCode === 200, JSON.stringify(revoke.body));
    check("revoke_sync_success", revoke.body?.data?.syncResults?.lms === "SUCCESS" && revoke.body?.data?.syncResults?.portal === "SKIPPED_V5", JSON.stringify(revoke.body));

    ({ data: enrollment, error: enrollmentError } = await supabase.from("student_enrollments").select("status,source_system,source_order_id").eq("email", email).eq("course_slug", slug).single());
    if (enrollmentError) throw enrollmentError;
    check("enrollment_revoked", enrollment.status === "revoked", JSON.stringify(enrollment));

    const resyncRevoked = await invoke(ordersHandler, { method: "PUT", headers: adminHeaders, body: { id: orderId, action: "resync" } });
    check("revoked_resync_http_200", resyncRevoked.statusCode === 200, JSON.stringify(resyncRevoked.body));
    check("revoked_resync_idempotent", resyncRevoked.body?.data?.syncResults?.lms === "SUCCESS", JSON.stringify(resyncRevoked.body));

    return { success: true, slug, email, checks };
  } catch (error) {
    return { success: false, error: error.message || String(error), slug, email, checks };
  } finally {
    if (previousTarget === undefined) delete process.env.V5_LMS_SYNC_URL;
    else process.env.V5_LMS_SYNC_URL = previousTarget;
    await supabase.from("student_enrollments").delete().eq("course_slug", slug).eq("email", email);
    await supabase.from("orders").delete().eq("id", orderId);
    const { data: courseRow } = await supabase.from("courses").select("id").eq("slug", slug).maybeSingle();
    if (courseRow?.id) {
      await supabase.from("v5_course_configs").delete().eq("course_id", courseRow.id);
      await supabase.from("courses").delete().eq("id", courseRow.id);
    }
    await supabase.from("students").delete().eq("email", email);
  }
}

export default async function handler(req, res) {
  if (req.method === "GET" && process.env.VERCEL_ENV === "preview" && String(req.query?.gate || "") === "v5-cross-repo") {
    const result = await runV5PreviewE2E();
    return res.status(result.success ? 200 : 500).json(result);
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const adminPassword = req.headers["x-admin-password"];
  const systemPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword || adminPassword !== systemPassword) {
    return res.status(401).json({ error: "Unauthorized: Mật khẩu Admin không chính xác." });
  }

  try {
    const course = String(req.body?.course || "").trim();
    if (!course) return res.status(400).json({ error: "Thiếu course slug" });
    return res.status(200).json(await approveCourse(course));
  } catch (error) {
    console.error("APPROVE_ALL_ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
}
