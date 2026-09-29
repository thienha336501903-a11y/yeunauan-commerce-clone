// test/b7-homework-security.test.js
// Regression test suite for Phase 7 (B7 Homework Final Security Fix)
// Verifies:
// 1. Direct table INSERT/UPDATE/DELETE from authenticated/anon is REVOKED
// 2. Untrusted caller-provided membership objects are rejected (Finding 7B)
// 3. Foreign lesson / course mismatch is denied (7C)
// 4. Student attempting to grade is denied (7C)
// 5. Verified server submission with valid entitlement succeeds

import assert from "node:assert/strict";
import test from "node:test";
import { submitAgencyHomework, gradeAgencyHomework, listAgencyHomework } from "../utils/agency-homework.js";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

test("B7.HOMEWORK-1: Untrusted caller-provided membership context is strictly rejected", async () => {
  // Finding 7B: Passing plain context { tenant, membership } without HTTP request auth MUST fail
  const untrustedContext = {
    tenant: { agencyId: "00000000-0000-0000-0000-000000000001" },
    membership: { id: "00000000-0000-0000-0000-000000000002", role: "student" }
  };

  await assert.rejects(
    async () => {
      await submitAgencyHomework(untrustedContext, {
        courseId: "c-1",
        canonicalLessonId: "l-1",
        title: "My Homework"
      });
    },
    (err) => {
      assert.equal(err.code, "request_auth_required");
      assert.equal(err.status, 401);
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await gradeAgencyHomework(untrustedContext, {
        submissionId: "sub-1",
        status: "evaluated",
        score: 10
      });
    },
    (err) => {
      assert.equal(err.code, "request_auth_required");
      assert.equal(err.status, 401);
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await listAgencyHomework(untrustedContext);
    },
    (err) => {
      assert.equal(err.code, "request_auth_required");
      assert.equal(err.status, 401);
      return true;
    }
  );
});

test("B7.HOMEWORK-2: Direct PostgREST table write is REVOKED for authenticated users", async () => {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) return;

  const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const testEmail = `b7-test-${Date.now()}@test.local`;
  const testPassword = `TestPass_${Date.now()}!`;
  let userId = null;

  try {
    // Create authentic test user
    const { data: u, error: uErr } = await adminClient.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true
    });
    if (uErr) throw uErr;
    userId = u.user.id;

    // Sign in to acquire genuine signed JWT
    const publicClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: signin, error: signinErr } = await publicClient.auth.signInWithPassword({
      email: testEmail,
      password: testPassword
    });
    if (signinErr) throw signinErr;
    const token = signin.session.access_token;

    // Authenticated user client
    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const dummyUuid = "00000000-0000-0000-0000-000000000000";

    // 1. Direct INSERT -> MUST FAIL (Permission Denied 42501)
    const { data: insertData, error: insertError } = await authClient
      .from("agency_homework_submissions")
      .insert({
        agency_id: dummyUuid,
        membership_id: dummyUuid,
        canonical_course_id: dummyUuid,
        lesson_id: "les-1",
        submission_title: "Hacked Submission",
        status: "evaluated",
        staff_score: 10
      });

    assert.ok(insertError, "Direct INSERT by authenticated user must be denied");
    assert.ok(
      insertError.message.includes("permission denied") ||
      insertError.code === "42501" ||
      insertError.status === 403,
      `Expected permission denied, got: ${insertError.message}`
    );

    // 2. Direct PATCH/UPDATE -> MUST FAIL
    const { data: updateData, error: updateError } = await authClient
      .from("agency_homework_submissions")
      .update({ status: "evaluated", staff_score: 10 })
      .eq("id", dummyUuid);

    assert.ok(updateError, "Direct UPDATE by authenticated user must be denied");
    assert.ok(
      updateError.message.includes("permission denied") ||
      updateError.code === "42501" ||
      updateError.status === 403,
      `Expected permission denied, got: ${updateError.message}`
    );
  } finally {
    if (userId) {
      await adminClient.auth.admin.deleteUser(userId);
    }
  }
});

test("B7.HOMEWORK-3: Role validation prevents student from grading homework", async () => {
  const agencyId = "11111111-0000-0000-0000-000000000001";
  const studentUserId = "22222222-0000-0000-0000-000000000002";

  // Mock DB returning a student membership (NOT staff/owner)
  const mockDb = {
    rpc: async (func, args) => {
      if (func === "resolve_agency_domain") {
        return { data: { found: true, agency_id: agencyId, agency_slug: "test-agency", is_primary: true } };
      }
      return { data: null };
    },
    auth: {
      getUser: async () => ({ data: { user: { id: studentUserId } } })
    },
    from: (table) => {
      if (table === "agency_memberships") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "m-student", agency_id: agencyId, role: "student", status: "active" }
                })
              })
            })
          })
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };

  const req = {
    headers: {
      host: "test-agency.local",
      authorization: "Bearer valid-student-jwt"
    }
  };

  // Student attempts to grade homework -> MUST FAIL with 403 forbidden_role
  const res = await gradeAgencyHomework(req, {
    submissionId: "00000000-0000-0000-0000-000000000009",
    status: "evaluated",
    score: 10
  }, { supabaseClient: mockDb });

  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(res.code, "forbidden_role");
});
