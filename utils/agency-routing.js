// utils/agency-routing.js
// System B Milestone B6 — Request Routing & Trusted Host Dispatch
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Milestone M0B.1 / Pre-M0C Remediation V2 Hardened Implementation

import { getTrustedHost, resolveTenant } from "./tenant-resolver.js";

/**
 * Returns the list of explicitly configured Legacy hostnames.
 * Reads from process.env.LEGACY_HOST_ALLOWLIST.
 */
export function getLegacyHostAllowlist() {
  const raw = process.env.LEGACY_HOST_ALLOWLIST || "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Checks whether the incoming hostname is an explicitly approved Legacy hostname.
 */
export function isExplicitLegacyHost(host) {
  if (!host) return false;
  const allowlist = getLegacyHostAllowlist();
  const normalizedHost = host.toLowerCase().split(":")[0];
  return allowlist.includes(host.toLowerCase()) || allowlist.includes(normalizedHost);
}

/**
 * Resolves request routing mode:
 * 1. Validates Host header and x-forwarded-host via getTrustedHost.
 * 2. Resolves Agency tenant from database.
 * 3. B6 5A OVERLAPPING HOST: If hostname is simultaneously an Agency domain AND in the Legacy allowlist -> DENY (409).
 * 4. Explicit Legacy host -> { route: "LEGACY", host }
 * 5. Valid Agency host -> { route: "AGENCY", tenant, host }
 * 6. Unknown / unmapped host -> { route: "DENY", status: 404, code: "unknown_tenant_host", error }
 * 
 * Strict invariant: NO fallback from unknown/invalid Agency host to Legacy!
 */
export async function resolveRequestRoute(req, options = {}) {
  let host;
  try {
    host = getTrustedHost(req);
  } catch (err) {
    return {
      route: "DENY",
      status: 400,
      code: "invalid_host_header",
      error: err.message || "Invalid or conflicting Host/Forwarded headers."
    };
  }

  if (!host) {
    return {
      route: "DENY",
      status: 400,
      code: "missing_host_header",
      error: "Host header is required, malformed, or has conflicting x-forwarded-host."
    };
  }

  const isLegacy = isExplicitLegacyHost(host);

  // Authoritatively resolve agency tenant from DB
  let resolved;
  try {
    resolved = await resolveTenant(req, options);
  } catch (err) {
    return {
      route: "DENY",
      status: 500,
      code: "tenant_resolution_error",
      error: err.message || "Tenant resolution failed."
    };
  }

  const isAgency = Boolean(resolved?.ok && resolved?.tenant?.agencyId);

  // ---------------------------------------------------------------------------
  // 5A: OVERLAPPING HOST DETECTION
  // A hostname must NOT simultaneously be Agency domain and Legacy allowlist host!
  // If overlap detected: DENY / configuration error (409). Do NOT prefer Legacy.
  // ---------------------------------------------------------------------------
  if (isLegacy && isAgency) {
    return {
      route: "DENY",
      status: 409,
      code: "overlapping_host_configuration",
      error: `Security violation: Hostname '${host}' cannot be simultaneously configured as an Agency tenant domain and an explicit Legacy allowlist hostname.`
    };
  }

  // Permitted explicit Legacy host
  if (isLegacy) {
    return { route: "LEGACY", host };
  }

  // Permitted verified Agency host
  if (isAgency) {
    return { route: "AGENCY", tenant: resolved.tenant, host };
  }

  // Unknown host fails closed
  return {
    route: "DENY",
    status: resolved?.status || 404,
    code: resolved?.code || "unknown_tenant_host",
    error: resolved?.error || "Unknown or unmapped agency tenant domain."
  };
}

/**
 * Checks whether an incoming request is addressed to an Agency tenant domain.
 */
export async function isAgencyRequest(req, options = {}) {
  const routeDecision = await resolveRequestRoute(req, options);
  return routeDecision.route === "AGENCY";
}
