// utils/agency-auth.js
// System B Milestone B2 — Global Identity & Agency Membership Authorization (Commerce)
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md

import { supabase as defaultSupabase } from "./supabase.js";

const LEGACY_COOKIE_NAMES = ["admin_session_token", "student_session_token", "lms_session_id"];
const SUPABASE_COOKIE_NAMES = ["sb-access-token", "supabase-auth-token", "sb-auth-token"];

/**
 * Parses cookies from request headers.
 */
function parseCookies(req) {
  const cookieHeader = req?.headers?.cookie;
  if (!cookieHeader || typeof cookieHeader !== "string") return {};

  const cookies = {};
  cookieHeader.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  });
  return cookies;
}

/**
 * Extracts Supabase Auth access token from request.
 * Checks Authorization header first (Bearer <token>), then Supabase auth cookies.
 * Rejects legacy HMAC session cookies.
 */
export function extractAuthToken(req) {
  if (!req || !req.headers) return { token: null, isLegacy: false };

  // 1. Check Authorization header
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (typeof authHeader === "string") {
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      const token = parts[1].trim();
      if (token) return { token, isLegacy: false };
    }
  }

  // 2. Check cookies
  const cookies = parseCookies(req);

  // Check if caller is attempting to use an old legacy HMAC session token on new agency path
  for (const legacyName of LEGACY_COOKIE_NAMES) {
    if (cookies[legacyName]) {
      return { token: null, isLegacy: true, legacyCookie: legacyName };
    }
  }

  for (const sbCookie of SUPABASE_COOKIE_NAMES) {
    if (cookies[sbCookie]) {
      const val = cookies[sbCookie];
      if (val.startsWith("[")) {
        try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed) && typeof parsed[0] === "string") {
            return { token: parsed[0], isLegacy: false };
          }
        } catch {
          // continue
        }
      }
      return { token: val, isLegacy: false };
    }
  }

  return { token: null, isLegacy: false };
}

/**
 * Validates Supabase Auth principal from request.
 * Returns { ok: true, user, token } or { ok: false, status, code, error }.
 * B2.2: Enforces stable auth.users.id; does NOT trust email string, user_metadata, or legacy tokens.
 */
export async function requireAuthenticatedUser(req, options = {}) {
  const client = options.supabaseClient || defaultSupabase;

  const { token, isLegacy, legacyCookie } = extractAuthToken(req);

  if (isLegacy) {
    return {
      ok: false,
      status: 401,
      code: "legacy_auth_rejected",
      error: `Legacy session (${legacyCookie}) is not supported on agency tenant paths. Please sign in via Supabase Auth.`
    };
  }

  if (!token) {
    return {
      ok: false,
      status: 401,
      code: "unauthenticated",
      error: "Authentication required. Missing Bearer token or Supabase session."
    };
  }

  try {
    // Validate JWT session against Supabase Auth
    const { data, error } = await client.auth.getUser(token);

    if (error || !data || !data.user || !data.user.id) {
      return {
        ok: false,
        status: 401,
        code: "invalid_session",
        error: error?.message || "Invalid or expired Supabase authentication session."
      };
    }

    return {
      ok: true,
      user: data.user,
      token
    };
  } catch (err) {
    console.error("[agency-auth] Unexpected authentication error:", err);
    return {
      ok: false,
      status: 500,
      code: "auth_error",
      error: "Failed to verify authentication credentials."
    };
  }
}

/**
 * Validates that authenticated user has an active membership in the resolved agency.
 * Returns { ok: true, user, membership, tenant } or { ok: false, status, code, error }.
 * B2.3: Enforces membership integrity, multi-agency scoping, and active status.
 */
export async function requireAgencyMembership(req, tenantContext, options = {}) {
  const client = options.supabaseClient || defaultSupabase;

  if (!tenantContext || !tenantContext.agencyId) {
    return {
      ok: false,
      status: 500,
      code: "missing_tenant_context",
      error: "Tenant context is required for membership authorization."
    };
  }

  // 1. Authenticate user principal
  const authResult = await requireAuthenticatedUser(req, options);
  if (!authResult.ok) return authResult;

  const user = authResult.user;

  try {
    // 2. Query agency_memberships strictly by auth.users.id AND tenantContext.agencyId
    const { data: membership, error } = await client
      .from("agency_memberships")
      .select("id, agency_id, user_id, role, display_name, phone, status, created_at")
      .eq("user_id", user.id)
      .eq("agency_id", tenantContext.agencyId)
      .maybeSingle();

    if (error) {
      console.error("[agency-auth] Database error fetching membership:", error);
      return {
        ok: false,
        status: 500,
        code: "membership_error",
        error: "Failed to verify agency membership."
      };
    }

    if (!membership) {
      return {
        ok: false,
        status: 403,
        code: "membership_not_found",
        error: "User is not a member of the requested agency."
      };
    }

    // 3. Verify active status (reject suspended / banned memberships)
    if (membership.status !== "active") {
      return {
        ok: false,
        status: 403,
        code: "membership_suspended",
        error: `Agency membership is ${membership.status}. Access denied.`
      };
    }

    // 4. Disallow any caller-provided or user_metadata role overrides
    // Role is anchored strictly to database agency_memberships.role
    return {
      ok: true,
      user,
      membership,
      tenant: tenantContext
    };
  } catch (err) {
    console.error("[agency-auth] Unexpected membership error:", err);
    return {
      ok: false,
      status: 500,
      code: "membership_error",
      error: "Unexpected error validating agency membership."
    };
  }
}

/**
 * Validates that authenticated user has one of the allowed roles in the resolved agency.
 * Allowed roles conceptual list: 'student', 'agency_staff', 'agency_owner'.
 * Platform administration remains separate (B2.5).
 */
export async function requireAgencyRole(req, tenantContext, allowedRoles = [], options = {}) {
  const memberResult = await requireAgencyMembership(req, tenantContext, options);
  if (!memberResult.ok) return memberResult;

  const { membership } = memberResult;

  if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
    if (!allowedRoles.includes(membership.role)) {
      return {
        ok: false,
        status: 403,
        code: "forbidden_role",
        error: `Insufficient role permissions. Required one of: [${allowedRoles.join(", ")}], but member has role '${membership.role}'.`
      };
    }
  }

  return memberResult;
}
