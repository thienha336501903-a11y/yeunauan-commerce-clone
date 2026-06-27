export async function syncCourseToExternalSystems(courseData) {
  const secret = process.env.INTERNAL_SYNC_SECRET;
  const sys1Url = process.env.SYSTEM1_URL;
  const sys3Url = process.env.SYSTEM3_URL;
  
  const results = { lms: "SKIPPED", portal: "SKIPPED", error: null };
  
  if (!secret) {
    results.error = "Missing INTERNAL_SYNC_SECRET";
    return results;
  }
  
  const payload = {
    action: "syncCourse",
    slug: courseData.slug,
    title: courseData.courseName || courseData.title,
    subtitle: courseData.subtitle || "",
    price: courseData.price || "",
    imageUrl: courseData.imageUrl || courseData.image_url || "",
    active: courseData.active !== undefined ? courseData.active : true,
    teacher: courseData.teacher_name || ""
  };
  
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
          active: payload.active
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
  const sys1Url = process.env.SYSTEM1_URL;
  const sys3Url = process.env.SYSTEM3_URL;
  
  const results = { lms: "SKIPPED", portal: "SKIPPED", error: null };
  
  if (!secret) {
    results.error = "Missing INTERNAL_SYNC_SECRET";
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
  
  return results;
}
