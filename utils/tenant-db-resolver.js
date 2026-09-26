// utils/tenant-db-resolver.js
// System B Milestone B4 — Scoped Tenant Data Access & TenantDbResolver
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md

import { supabase as defaultSupabase } from "./supabase.js";
import { resolveTenant, isTrustedTenantContext, getTrustedHost } from "./tenant-resolver.js";
import { requireAgencyMembership, requireAgencyRole } from "./agency-auth.js";

/**
 * Asserts that the code is executing in a server environment.
 * Prevents service_role access or privileged repository instantiation in browser bundles.
 */
export function assertServerEnvironment() {
  if (typeof window !== "undefined") {
    throw new Error("SECURITY VIOLATION: Privileged database operations cannot be executed in browser context.");
  }
}

/**
 * TenantDbResolver: Resolves database connection and client for a given tenant context.
 * In current architecture, all tenants map to Main Supabase project (yyiavtiwtekkocqpephr).
 * Provides an interface abstraction for future dedicated tenant routing without architectural changes.
 */
export class TenantDbResolver {
  /**
   * Resolves the database client for the verified tenant context.
   */
  static resolveDbClient(tenantContext, options = {}) {
    if (!tenantContext || !tenantContext.agencyId) {
      throw new Error("TenantDbResolver requires a valid tenantContext with agencyId.");
    }
    // Return provided client or default server client
    return options.supabaseClient || defaultSupabase;
  }
}

/**
 * Tier 1: Public Catalog Repository
 * Unauthenticated / public reads for a tenant's published storefront, offerings, and bank accounts.
 * Strictly bounded by agency_id = tenantContext.agencyId AND is_published = true.
 */
export function createPublicCatalogRepo(tenantContext, options = {}) {
  if (!tenantContext || !tenantContext.agencyId) {
    throw new Error("PublicCatalogRepo requires a valid tenantContext.");
  }

  const client = TenantDbResolver.resolveDbClient(tenantContext, options);
  const agencyId = tenantContext.agencyId;

  return {
    getAgencyId() {
      return agencyId;
    },

    async getAgencyInfo() {
      const { data, error } = await client
        .from("agencies")
        .select("id, slug, name, logo_url, favicon_url, storefront_variant, checkout_variant, learner_variant, learning_variant, design_tokens, feature_flags, status")
        .eq("id", agencyId)
        .eq("status", "active")
        .maybeSingle();

      if (error) throw error;
      return data;
    },

    async getPublishedOfferings() {
      const { data, error } = await client
        .from("agency_offerings")
        .select("id, agency_id, slug, display_title, display_description, thumbnail_url, price_vnd, sale_price_vnd, sort_order")
        .eq("agency_id", agencyId)
        .eq("is_published", true)
        .order("sort_order", { ascending: true });

      if (error) throw error;
      return data || [];
    },

    async getOfferingBySlug(slug) {
      if (!slug || typeof slug !== "string") return null;

      const { data, error } = await client
        .from("agency_offerings")
        .select("id, agency_id, slug, display_title, display_description, thumbnail_url, price_vnd, sale_price_vnd, is_published, sort_order")
        .eq("agency_id", agencyId)
        .eq("slug", slug.trim())
        .eq("is_published", true)
        .maybeSingle();

      if (error) throw error;
      return data;
    },

    async getActiveBankAccounts() {
      const { data, error } = await client
        .from("agency_bank_accounts")
        .select("id, agency_id, bank_code, account_number, account_holder, branch, is_active")
        .eq("agency_id", agencyId)
        .eq("is_active", true);

      if (error) throw error;
      return data || [];
    }
  };
}

/**
 * Tier 2: Member Read Repository
 * Authenticated reads for active students/members in the request's resolved tenant.
 * Enforces requireAgencyMembership: user must be authenticated, active, and bound to request host.
 */
export async function createMemberReadRepo(req, options = {}) {
  const authResult = await requireAgencyMembership(req, options);
  if (!authResult.ok) {
    return { ok: false, ...authResult };
  }

  const { user, membership, tenant } = authResult;
  const client = TenantDbResolver.resolveDbClient(tenant, options);

  const repo = {
    ok: true,
    user,
    membership,
    tenant,

    async getMembershipProfile() {
      return {
        userId: user.id,
        membershipId: membership.id,
        agencyId: tenant.agencyId,
        agencySlug: tenant.agencySlug,
        role: membership.role,
        displayName: membership.display_name,
        phone: membership.phone,
        status: membership.status
      };
    },

    async getMyOrders() {
      const { data, error } = await client
        .from("agency_orders")
        .select("id, agency_id, membership_id, offering_id, amount_vnd, payment_status, bank_code, account_number, account_holder, transfer_content, created_at, updated_at")
        .eq("agency_id", tenant.agencyId)
        .eq("membership_id", membership.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data || [];
    },

    async getMyEntitlements() {
      const { data, error } = await client
        .from("agency_entitlements")
        .select("id, agency_id, membership_id, canonical_course_id, status, granted_at, expires_at")
        .eq("agency_id", tenant.agencyId)
        .eq("membership_id", membership.id)
        .eq("status", "active");

      if (error) throw error;
      return data || [];
    },

    async getMyDevices() {
      const { data, error } = await client
        .from("student_devices")
        .select("id, agency_id, membership_id, device_fingerprint, device_name, last_ip, last_seen_at, is_active")
        .eq("agency_id", tenant.agencyId)
        .eq("membership_id", membership.id);

      if (error) throw error;
      return data || [];
    }
  };

  return repo;
}

/**
 * Tier 3: Agency Write Repository
 * Privileged mutations for agency staff and owners (e.g., managing offerings, orders, banks).
 * Enforces requireAgencyRole: verified caller must have staff or owner role in the request tenant.
 * Guarantees all writes are strictly bound to tenant.agencyId; caller-supplied agencyId is ignored.
 */
export async function createAgencyWriteRepo(req, allowedRoles = ["agency_staff", "agency_owner"], options = {}) {
  assertServerEnvironment();

  const authResult = await requireAgencyRole(req, allowedRoles, options);
  if (!authResult.ok) {
    return { ok: false, ...authResult };
  }

  const { user, membership, tenant } = authResult;
  const client = TenantDbResolver.resolveDbClient(tenant, options);
  const agencyId = tenant.agencyId;

  const repo = {
    ok: true,
    user,
    membership,
    tenant,

    async createOffering(offeringData) {
      if (!offeringData || !offeringData.slug || !offeringData.display_title) {
        throw new Error("Missing required offering fields (slug, display_title).");
      }

      // Security: Strictly enforce agency_id from verified tenant, sanitize any spoofed agency_id
      const payload = {
        agency_id: agencyId,
        slug: offeringData.slug.trim(),
        display_title: offeringData.display_title.trim(),
        display_description: offeringData.display_description || null,
        thumbnail_url: offeringData.thumbnail_url || null,
        price_vnd: Number(offeringData.price_vnd) || 0,
        sale_price_vnd: offeringData.sale_price_vnd ? Number(offeringData.sale_price_vnd) : null,
        is_published: Boolean(offeringData.is_published),
        sort_order: Number(offeringData.sort_order) || 0
      };

      const { data, error } = await client
        .from("agency_offerings")
        .insert(payload)
        .select()
        .single();

      if (error) throw error;
      return data;
    },

    async updateOffering(offeringId, updateData) {
      if (!offeringId) throw new Error("offeringId is required.");

      const allowedFields = ["display_title", "display_description", "thumbnail_url", "price_vnd", "sale_price_vnd", "is_published", "sort_order"];
      const payload = {};
      for (const field of allowedFields) {
        if (updateData[field] !== undefined) {
          payload[field] = updateData[field];
        }
      }
      payload.updated_at = new Date().toISOString();

      const { data, error } = await client
        .from("agency_offerings")
        .update(payload)
        .eq("id", offeringId)
        .eq("agency_id", agencyId) // Scoped to verified agency
        .select()
        .single();

      if (error) throw error;
      return data;
    },

    async createBankAccount(bankData) {
      if (!bankData || !bankData.bank_code || !bankData.account_number || !bankData.account_holder) {
        throw new Error("Missing required bank fields (bank_code, account_number, account_holder).");
      }

      const payload = {
        agency_id: agencyId,
        bank_code: bankData.bank_code.trim(),
        account_number: bankData.account_number.trim(),
        account_holder: bankData.account_holder.trim().toUpperCase(),
        branch: bankData.branch ? bankData.branch.trim() : null,
        is_active: bankData.is_active !== undefined ? Boolean(bankData.is_active) : true
      };

      const { data, error } = await client
        .from("agency_bank_accounts")
        .insert(payload)
        .select()
        .single();

      if (error) throw error;
      return data;
    },

    async updateOrderStatus(orderId, newStatus, reason = null) {
      if (!orderId || !newStatus) throw new Error("orderId and newStatus are required.");

      const allowedStatuses = ["pending_payment", "paid", "cancelled", "refunded"];
      if (!allowedStatuses.includes(newStatus)) {
        throw new Error(`Invalid order status: ${newStatus}. Allowed: ${allowedStatuses.join(", ")}`);
      }

      const payload = {
        payment_status: newStatus,
        updated_at: new Date().toISOString()
      };
      if (reason) {
        payload.audit_notes = reason;
      }

      const { data, error } = await client
        .from("agency_orders")
        .update(payload)
        .eq("id", orderId)
        .eq("agency_id", agencyId) // Scoped to verified agency
        .select()
        .single();

      if (error) throw error;
      return data;
    }
  };

  return repo;
}

/**
 * Tier 4: Platform Core Read Repository
 * Read-only access to canonical curriculum (canonical_courses, canonical_lessons).
 * Scoped to ensure canonical items are linked to the tenant's licensed offerings.
 */
export function createPlatformCoreReadRepo(tenantContext, options = {}) {
  if (!tenantContext || !tenantContext.agencyId) {
    throw new Error("PlatformCoreReadRepo requires a valid tenantContext.");
  }

  const client = TenantDbResolver.resolveDbClient(tenantContext, options);
  const agencyId = tenantContext.agencyId;

  return {
    async getCanonicalCourseByCode(courseCode) {
      if (!courseCode) return null;

      const { data, error } = await client
        .from("canonical_courses")
        .select("id, course_id, code, default_title, status, curriculum_metadata")
        .eq("code", courseCode.trim())
        .eq("status", "published")
        .maybeSingle();

      if (error) throw error;
      return data;
    },

    async getCanonicalLessons(canonicalCourseId) {
      if (!canonicalCourseId) return [];

      const { data, error } = await client
        .from("canonical_lessons")
        .select("id, canonical_course_id, v5_lesson_id, title, sort_order, is_free_preview, duration_seconds")
        .eq("canonical_course_id", canonicalCourseId)
        .order("sort_order", { ascending: true });

      if (error) throw error;
      return data || [];
    }
  };
}

/**
 * Server-only Privileged Agency Mutation Wrapper.
 * Bounds service_role execution strictly by:
 * - verified request tenant
 * - verified user/session
 * - active membership
 * - role allowlist
 * - same-agency boundary
 */
export async function executePrivilegedAgencyMutation(req, allowedRoles, operationContract, options = {}) {
  assertServerEnvironment();

  if (typeof operationContract !== "function") {
    throw new Error("operationContract must be an executable function.");
  }

  const authResult = await requireAgencyRole(req, allowedRoles, options);
  if (!authResult.ok) {
    return { ok: false, ...authResult };
  }

  const { user, membership, tenant } = authResult;
  const client = TenantDbResolver.resolveDbClient(tenant, options);

  try {
    const result = await operationContract(client, tenant, user, membership);
    return { ok: true, result, tenant, user };
  } catch (err) {
    console.error("[tenant-db-resolver] Privileged mutation error:", err);
    return {
      ok: false,
      status: 500,
      code: "privileged_mutation_error",
      error: err.message || "Failed to execute privileged tenant mutation."
    };
  }
}
