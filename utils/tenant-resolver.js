// utils/tenant-resolver.js
// System B Milestone B3.1 — Trusted Host / Tenant Resolver
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md

import { supabase as defaultSupabase } from "./supabase.js";

// Safe in-memory tenant cache: key = normalizedHost, value = { tenantContext, expiresAt }
const tenantCache = new Map();
const DEFAULT_TTL_MS = 60 * 1000; // 60 seconds
const NEGATIVE_TTL_MS = 5 * 1000; // 5 seconds for negative lookup to prevent hammering

// Unforgeable private WeakSet to brand resolver-issued TenantContext instances
const trustedContextSet = new WeakSet();

/**
 * Checks whether an object is a genuine, unforgeable TenantContext issued by this resolver.
 */
export function isTrustedTenantContext(ctx) {
  return typeof ctx === "object" && ctx !== null && trustedContextSet.has(ctx);
}

/**
 * Normalizes host input according to strict security rules.
 * Supports only:
 * - hostname
 * - hostname:port (port 1..65535, digits only, no leading zeros)
 * FQDN trailing dot is stripped AFTER full syntax validation.
 * Returns normalized hostname or null if invalid/ambiguous/malformed.
 */
export function normalizeHost(rawHost) {
  if (typeof rawHost !== "string") return null;

  const trimmed = rawHost.trim();
  if (!trimmed) return null;

  // Reject internal whitespace tricks
  if (/\s/.test(trimmed)) return null;

  // Reject ambiguous / prohibited characters
  // Comma (multiple values), slashes, backslashes, scheme markers, userinfo, query/fragment, IPv6 brackets
  if (
    trimmed.includes(",") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("://") ||
    trimmed.includes("@") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.includes("[") ||
    trimmed.includes("]")
  ) {
    return null;
  }

  // Parse authority: hostname and optional port
  let hostPart = trimmed;
  let portPart = null;

  if (trimmed.includes(":")) {
    const colonParts = trimmed.split(":");
    // Reject multiple colons (e.g., host:443:bad or IPv6)
    if (colonParts.length !== 2) return null;
    hostPart = colonParts[0];
    portPart = colonParts[1];

    // Validate port: digits only, range 1 to 65535
    if (!/^[0-9]{1,5}$/.test(portPart)) return null;
    const portNum = Number.parseInt(portPart, 10);
    if (portNum < 1 || portNum > 65535) return null;
    // Disallow leading zeros (e.g. 080 or 0)
    if (String(portNum) !== portPart) return null;
  }

  // Trailing dot normalization (RFC FQDN root dot)
  // Strip at most one trailing dot AFTER ensuring it's not ".." or empty
  if (hostPart.endsWith(".")) {
    if (hostPart.endsWith("..")) return null;
    hostPart = hostPart.slice(0, -1);
  }

  if (!hostPart) return null;

  // Lowercase
  hostPart = hostPart.toLowerCase();

  // Development/localhost rule
  if (hostPart === "localhost") {
    return "localhost";
  }

  // RFC 1123 domain name validation:
  // Each label 1-63 alphanumeric/hyphen chars, cannot start or end with hyphen.
  // Must contain at least two labels separated by dots.
  const domainRegex = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  if (!domainRegex.test(hostPart)) {
    return null;
  }

  return hostPart;
}

/**
 * Extracts and normalizes the trusted host from request headers.
 * BLOCKER 3: Host header is the sole tenant authority.
 * If x-forwarded-host is present:
 * - Validate it.
 * - If x-forwarded-host conflicts with host => DENY (return null).
 * - If x-forwarded-host is malformed => DENY (return null).
 * - Never let x-forwarded-host override host.
 * If x-forwarded-host is absent:
 * - Host header is validated and used.
 * Multiple/array-valued Host or x-forwarded-host => DENY (return null).
 */
export function getTrustedHost(req) {
  if (!req || !req.headers) return null;

  // Header spoof guards: reject/ignore untrusted headers
  // Headers such as x-agency-id, x-agency-slug, x-trusted-agency-id, x-tenant-*
  // are never consulted.

  const rawHostHeader = req.headers["host"];
  // Reject array-valued host header
  if (Array.isArray(rawHostHeader)) {
    return null;
  }
  if (typeof rawHostHeader !== "string") {
    return null;
  }

  const normalizedHost = normalizeHost(rawHostHeader);
  if (!normalizedHost) {
    return null;
  }

  // Inspect x-forwarded-host
  const rawForwardedHeader = req.headers["x-forwarded-host"];

  // If x-forwarded-host is present:
  if (rawForwardedHeader !== undefined && rawForwardedHeader !== null) {
    // Array-valued x-forwarded-host must be rejected immediately
    if (Array.isArray(rawForwardedHeader)) {
      return null;
    }
    if (typeof rawForwardedHeader !== "string") {
      return null;
    }

    const trimmedForwarded = rawForwardedHeader.trim();
    if (trimmedForwarded.length > 0) {
      // Must validate forwarded host
      const normalizedForwarded = normalizeHost(trimmedForwarded);
      // Malformed forwarded host => DENY (do not silently fall back to host)
      if (!normalizedForwarded) {
        return null;
      }
      // Conflicting forwarded host => DENY
      if (normalizedForwarded !== normalizedHost) {
        return null;
      }
    }
  }

  return normalizedHost;
}

/**
 * Resolves tenant from request.
 * Returns { ok: true, tenant: TenantContext } or { ok: false, code, status, error }.
 * Fails closed if host is unknown, inactive, or invalid.
 */
export async function resolveTenant(req, options = {}) {
  const surface = options.surface || "commerce";
  const client = options.supabaseClient || defaultSupabase;
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;

  const normalizedHost = getTrustedHost(req);
  if (!normalizedHost) {
    return {
      ok: false,
      status: 400,
      code: "invalid_host",
      error: "Host header is missing, malformed, or ambiguous"
    };
  }

  const now = Date.now();

  // Check in-memory cache
  if (tenantCache.has(normalizedHost)) {
    const entry = tenantCache.get(normalizedHost);
    if (entry.expiresAt > now) {
      if (entry.tenantContext) {
        return { ok: true, tenant: entry.tenantContext };
      }
      // Negative cache hit
      return {
        ok: false,
        status: 404,
        code: "tenant_not_found",
        error: "Unknown or inactive agency domain"
      };
    }
    tenantCache.delete(normalizedHost);
  }

  try {
    // Database lookup: call RPC resolve_agency_domain or perform query
    const { data, error } = await client.rpc("resolve_agency_domain", {
      p_hostname: normalizedHost
    });

    if (error) {
      console.error("[tenant-resolver] Database error resolving domain:", error);
      return {
        ok: false,
        status: 500,
        code: "resolver_error",
        error: "Failed to resolve agency domain"
      };
    }

    if (!data || !data.found || !data.agency_id) {
      // Fail closed: Unknown or inactive host.
      // Cache negative lookup briefly to prevent DoS hammering
      tenantCache.set(normalizedHost, {
        tenantContext: null,
        expiresAt: now + NEGATIVE_TTL_MS
      });
      return {
        ok: false,
        status: 404,
        code: "tenant_not_found",
        error: "Unknown or inactive agency domain"
      };
    }

    // Construct immutable Server-Only TenantContext (B3.4)
    const tenantContext = Object.freeze({
      agencyId: data.agency_id,
      agencySlug: data.agency_slug,
      agencyName: data.agency_name,
      hostname: normalizedHost,
      domainId: data.domain_id,
      domainStatus: data.domain_status || "active",
      sslStatus: data.ssl_status,
      isPrimary: Boolean(data.is_primary),
      surface
    });

    // Brand the instance into private WeakSet
    trustedContextSet.add(tenantContext);

    // Cache valid tenant
    tenantCache.set(normalizedHost, {
      tenantContext,
      expiresAt: now + ttlMs
    });

    return { ok: true, tenant: tenantContext };
  } catch (err) {
    console.error("[tenant-resolver] Unexpected error:", err);
    return {
      ok: false,
      status: 500,
      code: "resolver_error",
      error: "Unexpected error resolving agency tenant"
    };
  }
}

/**
 * Clear the in-memory cache (for testing or administrative eviction)
 */
export function _clearTenantCache() {
  tenantCache.clear();
}
