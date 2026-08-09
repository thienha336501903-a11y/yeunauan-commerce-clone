import { supabase } from "./supabase.js";

export async function syncCourseToExternalSystems(courseData) {
  const secret = process.env.INTERNAL_SYNC_SECRET;
  const sys1Url = process.env.SYSTEM1_URL || process.env.PORTAL_URL;
  const sys3Url = process.env.SYSTEM3_URL || process.env.LMS_PUBLIC_URL;
  
  const results = {
    lms: sys3Url ? "SKIPPED" : "DISABLED",
    portal: sys1Url ? "SKIPPED" : "DISABLED",
    error: null
  };
  
  if (!secret) {
    if (!sys3Url && !sys1Url) {
      results.lms = "DISABLED";
      results.portal = "DISABLED";
      results.error = null;
    } else {
      results.error = "Missing INTERNAL_SYNC_SECRET";
    }
    return results;
  }

  // Fetch is_published from Supabase B to verify publish status
  let isPublished = false;
  try {
    const { data: courseRow } = await supabase
      .from("courses")
      .select("is_published")
      .eq("slug", courseData.slug)
      .maybeSingle();
    if (courseRow) {
      isPublished = !!courseRow.is_published;
    }
  } catch (err) {
    console.error("Error fetching is_published during syncCourse:", err);
  }
  
  const payload = {
    action: "syncCourse",
    slug: courseData.slug,
    title: courseData.courseName || courseData.title,
    subtitle: courseData.subtitle || "",
    price: courseData.price || "",
    imageUrl: courseData.imageUrl || courseData.image_url || "",
    active: courseData.active !== undefined ? courseData.active : true,
    isPublished: isPublished,
    teacher: courseData.teacher_name || ""
  };
  const hasExpectedStartDate = Object.prototype.hasOwnProperty.call(courseData, "expected_start_date");
  if (hasExpectedStartDate) {
    payload.expected_start_date = courseData.expected_start_date;
  }
  
  // Call System 3 (LMS)
  if (sys3Url) {
    try {
      const res = await fetch(`${sys3Url.trim().replace(/\/$/, '')}/api/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sync-Secret": secret
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        results.lms = "SUCCESS";
      } else {
        const errData = await res.json().catch(() => ({}));
        results.lms = "FAILED";
        results.error = `LMS failed: ${errData.error || res.statusText}`;
      }
    } catch (err) {
      results.lms = "FAILED";
      results.error = `LMS error: ${err.message}`;
    }
  }
  
  // Call System 1 (Portal)
  if (sys1Url) {
    try {
      const res = await fetch(`${sys1Url.trim().replace(/\/$/, '')}/api/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sync-Secret": secret
        },
        body: JSON.stringify({
          action: "syncCourse",
          courseSlug: payload.slug,
          title: payload.title,
          imageUrl: payload.imageUrl,
          active: payload.active,
          isPublished: payload.isPublished,
          ...(hasExpectedStartDate ? { expected_start_date: payload.expected_start_date } : {})
        })
      });
      if (res.ok) {
        const resData = await res.json().catch(() => ({}));
        let portalStatus = "SUCCESS";
        if (resData.projectRef) {
          portalStatus += ` (DB: ${resData.projectRef})`;
        }
        if (resData.postId) {
          portalStatus += ` (PostID: ${resData.postId})`;
        }
        results.portal = portalStatus;
      } else {
        const errData = await res.json().catch(() => ({}));
        results.portal = "FAILED";
        results.error = (results.error ? results.error + " | " : "") + `Portal failed: ${errData.error || res.statusText}`;
      }
    } catch (err) {
      results.portal = "FAILED";
      results.error = (results.error ? results.error + " | " : "") + `Portal error: ${err.message}`;
    }
  }
  
  return results;
}

export async function syncEnrollmentToExternalSystems(orderData, actionType) {
  const secret = process.env.INTERNAL_SYNC_SECRET;
  const sys1Url = process.env.SYSTEM1_URL || process.env.PORTAL_URL;
  const sys3Url = process.env.SYSTEM3_URL || process.env.LMS_PUBLIC_URL;
  
  const results = {
    lms: sys3Url ? "SKIPPED" : "DISABLED",
    portal: sys1Url ? "SKIPPED" : "DISABLED",
    error: null
  };
  
  if (!secret) {
    if (!sys3Url && !sys1Url) {
      results.lms = "DISABLED";
      results.portal = "DISABLED";
      results.error = null;
    } else {
      results.error = "Missing INTERNAL_SYNC_SECRET";
    }
    return results;
  }
  
  const email = orderData.customer_email || orderData.gmail;
  const courseSlug = orderData.course_slug || orderData.course;
  
  if (!email || !courseSlug) {
    results.error = "Missing email or course slug";
    return results;
  }
  
  const action = actionType === "create" ? "syncEnrollment" : "revokeEnrollment";
  
  // Call System 3 (LMS)
  if (sys3Url) {
    try {
      const res = await fetch(`${sys3Url.trim().replace(/\/$/, '')}/api/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sync-Secret": secret
        },
        body: JSON.stringify({ action, email, courseSlug })
      });
      if (res.ok) {
        results.lms = "SUCCESS";
      } else {
        const errData = await res.json().catch(() => ({}));
        results.lms = "FAILED";
        results.error = `LMS failed: ${errData.error || res.statusText}`;
      }
    } catch (err) {
      results.lms = "FAILED";
      results.error = `LMS error: ${err.message}`;
    }
  }
  
  // Call System 1 (Portal)
  if (sys1Url) {
    try {
      const res = await fetch(`${sys1Url.trim().replace(/\/$/, '')}/api/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sync-Secret": secret
        },
        body: JSON.stringify({ action, email, courseSlug })
      });
      if (res.ok) {
        const resData = await res.json().catch(() => ({}));
        let portalStatus = "SUCCESS";
        if (resData.projectRef) {
          portalStatus += ` (DB: ${resData.projectRef})`;
        }
        if (resData.postId) {
          portalStatus += ` (PostID: ${resData.postId})`;
        }
        results.portal = portalStatus;
      } else {
        const errData = await res.json().catch(() => ({}));
        results.portal = "FAILED";
        results.error = (results.error ? results.error + " | " : "") + `Portal failed: ${errData.error || res.statusText}`;
      }
    } catch (err) {
      results.portal = "FAILED";
      results.error = (results.error ? results.error + " | " : "") + `Portal error: ${err.message}`;
    }
  }
  
  // Trigger Email số 1 if enrollment is successfully created (approved)
  if (actionType === "create" && results.lms === "SUCCESS" && results.portal.startsWith("SUCCESS")) {
    try {
      await sendApprovalEmail(email, orderData.course_title || courseSlug);
    } catch (mailErr) {
      console.error("[Email Hook Error] Failed to send approval email:", mailErr);
    }
  }
  
  return results;
}

export async function sendApprovalEmail(email, courseName) {
  console.log(`[Email Hook - TODO] Gửi email số 1 duyệt khóa học đến ${email} cho khóa ${courseName}`);
  
  // TODO: Cấu hình SMTP / Resend / Gmail API tại đây để gửi email thực tế
  // Ví dụ sử dụng Resend:
  // const resend = new Resend(process.env.RESEND_API_KEY);
  // await resend.emails.send({
  //   from: 'Culinary Academy <academy@clone.example>',
  //   to: email,
  //   subject: 'Khóa học của bạn đã được xét duyệt',
  //   html: `<p>Khóa học <strong>${courseName}</strong> đã được Admin xét duyệt.</p>
  //          <p>Vui lòng truy cập LMS clone để xem trạng thái khóa học.</p>`
  // });
}
