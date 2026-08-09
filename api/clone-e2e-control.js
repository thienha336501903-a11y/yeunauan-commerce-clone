import crypto from "crypto";
import { v2 as cloudinary } from "cloudinary";
import { supabase } from "../utils/supabase.js";
import { syncEnrollmentToExternalSystems } from "../utils/sync-helpers.js";

const CLONE_REF = "yyiavtiwtekkocqpephr";
const TEST_BILL_NAME = "__clone_factory_test_bill_20260809.png";
const TEST_COURSE = "banhmi4k";

function isAuthorized(req) {
  const supplied = String(req.headers["x-admin-password"] || "");
  const expected = String(process.env.ADMIN_PASSWORD || "");
  if (!supplied || !expected || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function assertCloneProject() {
  const hostname = new URL(process.env.SUPABASE_URL || "https://invalid.local").hostname;
  if (hostname.split(".")[0] !== CLONE_REF) {
    throw new Error("Clone project guard rejected this operation");
  }
}

async function findTestOrders() {
  const { data, error } = await supabase
    .from("orders")
    .select("id, customer_email, course_slug, course_title, status, proof_image_url, raw_data")
    .eq("course_slug", TEST_COURSE)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw error;
  return (data || []).filter((order) => order.raw_data?.billName === TEST_BILL_NAME);
}

async function enrollmentRows(orders) {
  const rows = [];
  for (const order of orders) {
    const { data, error } = await supabase
      .from("student_enrollments")
      .select("id, student_id, email, course_slug, status")
      .eq("email", order.customer_email)
      .eq("course_slug", order.course_slug);
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

function publicIdFromCloudinaryUrl(url) {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    const afterUpload = path.split("/upload/")[1] || "";
    const withoutVersion = afterUpload.replace(/^v\d+\//, "");
    return withoutVersion.replace(/\.[a-z0-9]+$/i, "");
  } catch {
    return "";
  }
}

async function statusPayload() {
  const orders = await findTestOrders();
  const enrollments = await enrollmentRows(orders);
  return {
    success: true,
    cloneRefOk: true,
    testOrderCount: orders.length,
    orderStatuses: orders.map((order) => order.status),
    enrollmentCount: enrollments.length,
    enrollmentStatuses: enrollments.map((row) => row.status)
  };
}

async function approveTestOrder() {
  const orders = await findTestOrders();
  if (orders.length !== 1) {
    throw new Error(`Expected exactly one test order, found ${orders.length}`);
  }

  const order = orders[0];
  const preexistingEnrollments = await enrollmentRows([order]);
  if (preexistingEnrollments.length !== 0) {
    throw new Error("Safety guard: the test account already has an enrollment");
  }
  const { data: preexistingStudent, error: studentLookupError } = await supabase
    .from("students")
    .select("id")
    .eq("email", order.customer_email)
    .maybeSingle();
  if (studentLookupError) throw studentLookupError;

  const markedRawData = {
    ...(order.raw_data || {}),
    e2eControlVersion: 1,
    preexistingEnrollmentCount: 0,
    preexistingStudentId: preexistingStudent?.id || null
  };
  const { data: approved, error: updateError } = await supabase
    .from("orders")
    .update({ status: "Đã duyệt", raw_data: markedRawData, updated_at: new Date().toISOString() })
    .eq("id", order.id)
    .select()
    .single();
  if (updateError) throw updateError;

  const syncResults = await syncEnrollmentToExternalSystems(approved, "create");
  const createdEnrollments = await enrollmentRows([approved]);
  if (createdEnrollments.length !== 1) {
    throw new Error(`Expected exactly one created enrollment, found ${createdEnrollments.length}`);
  }
  const createdEnrollment = createdEnrollments[0];
  const { error: syncUpdateError } = await supabase
    .from("orders")
    .update({
      sync_lms_status: syncResults.lms,
      sync_portal_status: syncResults.portal,
      sync_error: syncResults.error,
      raw_data: {
        ...markedRawData,
        createdEnrollmentId: createdEnrollment.id,
        createdStudentId: createdEnrollment.student_id
      }
    })
    .eq("id", order.id);
  if (syncUpdateError) throw syncUpdateError;

  return statusPayload();
}

async function cleanupTestData() {
  const orders = await findTestOrders();
  let deletedEnrollments = 0;
  let deletedOrders = 0;
  let deletedImages = 0;

  for (const order of orders) {
    if (order.raw_data?.e2eControlVersion !== 1 || order.raw_data?.preexistingEnrollmentCount !== 0) {
      throw new Error("Safety guard: missing clean pre-approval baseline marker");
    }

    const createdEnrollmentId = order.raw_data?.createdEnrollmentId;
    const createdStudentId = order.raw_data?.createdStudentId;
    if (!createdEnrollmentId) {
      throw new Error("Safety guard: missing exact test enrollment ID");
    }

    const { data: enrollment, error: enrollmentLookupError } = await supabase
      .from("student_enrollments")
      .select("id, email, course_slug")
      .eq("id", createdEnrollmentId)
      .maybeSingle();
    if (enrollmentLookupError) throw enrollmentLookupError;
    if (enrollment && (enrollment.email !== order.customer_email || enrollment.course_slug !== order.course_slug)) {
      throw new Error("Safety guard: enrollment identity mismatch");
    }

    if (enrollment) {
      await syncEnrollmentToExternalSystems(order, "revoke");
      const { data: remainingExact, error: exactLookupError } = await supabase
        .from("student_enrollments")
        .select("id")
        .eq("id", createdEnrollmentId)
        .maybeSingle();
      if (exactLookupError) throw exactLookupError;
      if (remainingExact) {
        const { data: removedEnrollment, error: enrollmentError } = await supabase
          .from("student_enrollments")
          .delete()
          .eq("id", createdEnrollmentId)
          .select("id");
        if (enrollmentError) throw enrollmentError;
        deletedEnrollments += (removedEnrollment || []).length;
      } else {
        deletedEnrollments += 1;
      }
    }

    if (!order.raw_data?.preexistingStudentId && createdStudentId) {
      const { count, error: studentEnrollmentError } = await supabase
        .from("student_enrollments")
        .select("id", { count: "exact", head: true })
        .eq("student_id", createdStudentId);
      if (studentEnrollmentError) throw studentEnrollmentError;
      if (count === 0) {
        const { error: studentDeleteError } = await supabase
          .from("students")
          .delete()
          .eq("id", createdStudentId);
        if (studentDeleteError) throw studentDeleteError;
      }
    }

    const { data: removedOrders, error: orderError } = await supabase
      .from("orders")
      .delete()
      .eq("id", order.id)
      .select("id");
    if (orderError) throw orderError;
    deletedOrders += (removedOrders || []).length;

    const publicId = publicIdFromCloudinaryUrl(order.proof_image_url);
    if (publicId && process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
      });
      const result = await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
      if (result?.result === "ok" || result?.result === "not found") deletedImages += 1;
    }
  }

  const remaining = await findTestOrders();
  return {
    success: true,
    cloneRefOk: true,
    deletedOrders,
    deletedEnrollments,
    deletedImages,
    remainingTestOrders: remaining.length
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    assertCloneProject();
    const action = String(req.query?.action || "status");
    if (action === "status") return res.status(200).json(await statusPayload());
    if (action === "approve") return res.status(200).json(await approveTestOrder());
    if (action === "cleanup") return res.status(200).json(await cleanupTestData());
    return res.status(400).json({ success: false, error: "Unsupported action" });
  } catch (error) {
    console.error("CLONE_E2E_CONTROL_ERROR:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
