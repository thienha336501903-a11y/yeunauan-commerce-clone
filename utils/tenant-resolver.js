// utils/tenant-resolver.js
// System B Milestone B3 — Trusted Host / Tenant Resolver (Commerce)
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md

import { supabase as defaultSupabase } from "./supabase.js";

// Safe in-memory tenant cache: key = normalizedHost, value = { tenantContext, expiresAt }
const tenantCache = new Map();
const DEFAULT_TTL_MS = 60 * 1000; // 60 seconds
const NEGATIVE_TTL_MS = 5 * 1000; // 5 seconds for negative lookup to prevent hammering

/**
 * Normalizes host input according to strict security rules.
 * Returns normalized hostname or null if invalid/ambiguous/malformed.
 */
export function normalizeHost(rawHost) {
  if (typeof rawHost !== "string") return null;

  const trimmed = rawHost.trim();
  if (!trimmed) return null;

  // B3.2 & B3.3: Multiple / ambiguous forwarded host values must be rejected immediately
  if (trimmed.includes(",")) {
    return null;
  }

  // Reject URLs or paths masquerading as hosts
  if (trimmed.includes("://") || trimmed.includes("/") || trimmed.includes("\\")) {
    return null;
  }

  // Strip port if present
  let host = trimmed;
  if (host.includes(":")) {
    host = host.split(":")[0];
  }

  // Lowercase
  host = host.toLowerCase().trim();

  // Strip trailing dots (FQDN root dot)
  host = host.replace(/\.+$/, "");

  if (!host) return null;

  // Validate domain format (RFC 1123 compliant: alphanumeric labels separated by dots)
  // Also permits localhost for local development/testing
  if (host === "localhost") {
    return "localhost";
  }

  const domainRegex = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
  if (!domainRegex.test(host)) {
    return null;
  }

  return host;
}

/**
 * Extracts and normalizes the trusted host from request headers.
 * Precedence:
 * 1. x-forwarded-host (only if single, non-ambiguous value)
 * 2. host
 * Returns normalized hostname or null.
 */
export function getTrustedHost(req) {
  if (!req || !req.headers) return null;

  // B3.1: Explicitly ignore and reject any untrusted spoofing headers
  // Headers such as x-agency-id, x-agency-slug, x-trusted-agency-id, x-tenant-*
  // are never consulted.

  const forwardedHostHeader = req.headers["x-forwarded-host"];
  if (forwardedHostHeader) {
    const rawForwarded = Array.isArray(forwardedHostHeader) 
      ? forwardedHostHeader.join(",") 
      : String(forwardedHostHeader);
    
    // Multiple comma-separated forwarded hosts indicate proxy chaining or spoofing; fail closed
    if (rawForwarded.includes(",")) {
      return null;
    }
    const normalized = normalizeHost(rawForwarded);
    if (normalized) return normalized;
  }

  const hostHeader = req.headers["host"];
  if (hostHeader) {
    const rawHost = Array.isArray(hostHeader) ? hostHeader[0] : String(hostHeader);
    if (rawHost.includes(",")) {
      return null;
    }
    const normalized = normalizeHost(rawHost);
    if (normalized) return normalized;
  }

  return null;
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
    // Database lookup: call RPC resolve_agency_domain
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
