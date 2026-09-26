// utils/agency-auth.js
// System B Milestone B2.2 — Global Identity & Agency Membership Authorization
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md

import { supabase as defaultSupabase } from "./supabase.js";
import { getTrustedHost, isTrustedTenantContext, resolveTenant } from "./tenant-resolver.js";

const LEGACY_COOKIE_NAMES = ["admin_session_token", "student_session_token", "lms_session_id"];
const SUPABASE_COOKIE_NAMES = ["sb-access-token", "supabase-auth-token", "sb-auth-token"];

// B2.2: Strict role enum definition
const VALID_AGENCY_ROLES = new Set(["student", "agency_staff", "agency_owner"]);

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
 * B2.2 Rules:
 * - Authorization MUST resolve the CURRENT tenant from the CURRENT request.
 * - Any retained branded TenantContext is only a consistency assertion, never final authority.
 * - Stale contexts from domain remaps (same host A -> B) are strictly rejected.
 * - Fabricated contexts { agencyId } are rejected.
 * Returns { ok: true, user, membership, tenant } or { ok: false, status, code, error }.
 */
export async function requireAgencyMembership(req, tenantContextOrOptions, options = {}) {
  let callerContext = null;
  let opts = options;

  if (tenantContextOrOptions && typeof tenantContextOrOptions === "object") {
    if (isTrustedTenantContext(tenantContextOrOptions)) {
      callerContext = tenantContextOrOptions;
    } else if (tenantContextOrOptions.agencyId) {
      // Fabricated / plain object with agencyId rejected immediately!
      return {
        ok: false,
        status: 403,
        code: "untrusted_tenant_context",
        error: "Fabricated tenant context rejected. TenantContext must be issued by trusted tenant-resolver."
      };
    } else {
      opts = tenantContextOrOptions;
    }
  }

  // 1. Authoritative resolution: Always resolve CURRENT tenant from CURRENT request
  const resolveResult = await resolveTenant(req, opts);
  if (!resolveResult.ok) {
    return resolveResult;
  }
  const currentTenant = resolveResult.tenant;

  // 2. Consistency assertion: if a retained context was passed, ensure it matches current tenant
  if (callerContext) {
    if (callerContext.hostname !== currentTenant.hostname) {
      return {
        ok: false,
        status: 403,
        code: "tenant_host_mismatch",
        error: `Tenant context hostname (${callerContext.hostname}) does not match current request host (${currentTenant.hostname}).`
      };
    }
    // Check for domain remap: old context pointing to Agency A when host remapped to Agency B
    if (callerContext.agencyId !== currentTenant.agencyId) {
      return {
        ok: false,
        status: 403,
        code: "stale_tenant_context",
        error: "Retained tenant context does not match current tenant resolution for host (domain remap detected)."
      };
    }
  }

  const client = opts.supabaseClient || defaultSupabase;

  // 3. Authenticate user principal
  const authResult = await requireAuthenticatedUser(req, opts);
  if (!authResult.ok) return authResult;

  const user = authResult.user;

  try {
    // 4. Query agency_memberships strictly by auth.users.id AND currentTenant.agencyId
    const { data: membership, error } = await client
      .from("agency_memberships")
      .select("id, agency_id, user_id, role, display_name, phone, status, created_at")
      .eq("user_id", user.id)
      .eq("agency_id", currentTenant.agencyId)
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

    // 5. Verify active status (reject suspended / banned memberships)
    if (membership.status !== "active") {
      return {
        ok: false,
        status: 403,
        code: "membership_suspended",
        error: `Agency membership is ${membership.status}. Access denied.`
      };
    }

    // 6. Return authorized membership bound to request and CURRENT verified tenant
    return {
      ok: true,
      user,
      membership,
      tenant: currentTenant
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
 * B2.2 Rules:
 * - allowedRoles MUST be a non-empty explicit array of valid role strings.
 * - Missing, empty, or non-array allowedRoles immediately fails closed.
 * - Rejects any unknown role value (only 'student', 'agency_staff', 'agency_owner' are valid).
 */
export async function requireAgencyRole(req, tenantContextOrRoles, allowedRolesOrOptions, maybeOptions = {}) {
  let tenantContext = null;
  let allowedRoles = null;
  let options = maybeOptions;

  if (Array.isArray(tenantContextOrRoles)) {
    allowedRoles = tenantContextOrRoles;
    options = allowedRolesOrOptions || {};
  } else {
    tenantContext = tenantContextOrRoles;
    allowedRoles = allowedRolesOrOptions;
    options = maybeOptions || {};
  }

  // 1. Fail closed if allowedRoles is missing, empty, or not an array
  if (
    !Array.isArray(allowedRoles) ||
    allowedRoles.length === 0 ||
    !allowedRoles.every((r) => typeof r === "string" && r.trim().length > 0)
  ) {
    return {
      ok: false,
      status: 500,
      code: "invalid_role_configuration",
      error: "requireAgencyRole requires a non-empty explicit allowedRoles array. For general membership, use requireAgencyMembership()."
    };
  }

  // 2. Reject any unknown role value. Valid roles only: student, agency_staff, agency_owner
  for (const role of allowedRoles) {
    if (!VALID_AGENCY_ROLES.has(role)) {
      return {
        ok: false,
        status: 500,
        code: "invalid_role_configuration",
        error: `Invalid role '${role}' in allowedRoles. Permitted roles are: ${Array.from(VALID_AGENCY_ROLES).join(", ")}.`
      };
    }
  }

  const memberResult = await requireAgencyMembership(req, tenantContext, options);
  if (!memberResult.ok) return memberResult;

  const { membership } = memberResult;

  if (!allowedRoles.includes(membership.role)) {
    return {
      ok: false,
      status: 403,
      code: "forbidden_role",
      error: `Insufficient role permissions. Required one of: [${allowedRoles.join(", ")}], but member has role '${membership.role}'.`
    };
  }

  return memberResult;
}
