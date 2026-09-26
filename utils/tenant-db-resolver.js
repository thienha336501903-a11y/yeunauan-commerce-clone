// utils/tenant-db-resolver.js
// System B Milestone B4 — Scoped Tenant Data Access & TenantDbResolver
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Milestone M0B.1 / Pre-M0C Remediation V2 Hardened Implementation

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
 * Validates and extracts a trusted TenantContext.
 * Accepts:
 *   1. An HTTP Request object -> calls resolveTenant(req)
 *   2. A pre-resolved branded TenantContext -> verifies via isTrustedTenantContext(ctx)
 * REJECTS plain unbranded objects like { agencyId: "..." }.
 */
export async function assertTrustedTenantInput(reqOrTenantContext, options = {}) {
  if (!reqOrTenantContext) {
    throw new Error("TenantContext or Request is required.");
  }

  // If it's an HTTP request (has headers property)
  if (reqOrTenantContext.headers || typeof reqOrTenantContext.getHeader === "function") {
    const resolveResult = await resolveTenant(reqOrTenantContext, options);
    if (!resolveResult.ok || !resolveResult.tenant) {
      const err = new Error(resolveResult.error || "Failed to resolve trusted tenant from request.");
      err.status = resolveResult.status || 404;
      err.code = resolveResult.code || "unknown_tenant";
      throw err;
    }
    return resolveResult.tenant;
  }

  // If it's a pre-resolved TenantContext, must satisfy isTrustedTenantContext
  if (isTrustedTenantContext(reqOrTenantContext)) {
    return reqOrTenantContext;
  }

  // Reject unbranded/fabricated objects
  throw new Error("SECURITY VIOLATION: TenantContext must be derived from trusted tenant resolver. Plain or unbranded objects are strictly rejected.");
}

/**
 * Private, non-exported helper to acquire client strictly within verified scoped repositories.
 * Enforces server environment and trusted branded TenantContext.
 * NEVER exposed directly to callers.
 */
function _getScopedDbClient(tenantContext, options = {}) {
  assertServerEnvironment();
  if (!tenantContext || !isTrustedTenantContext(tenantContext)) {
    throw new Error("SECURITY VIOLATION: Scoped database operations require a trusted TenantContext issued by tenant-resolver. Plain or fabricated objects are strictly rejected.");
  }
  return options.supabaseClient || defaultSupabase;
}

/**
 * TenantDbResolver:
 * Architectural guard: Generic resolveDbClient is STRICTLY PROHIBITED.
 * Callers must use narrow repositories or scoped operations.
 */
export class TenantDbResolver {
  static resolveDbClient() {
    throw new Error("SECURITY VIOLATION: Generic resolveDbClient is prohibited. Privileged database access must be performed via scoped repositories (createPublicCatalogRepo, createMemberReadRepo, createAgencyWriteRepo, createPlatformCoreReadRepo) or narrow operations (agencyOrderOperations, agencyHomeworkOperations).");
  }
}

/**
 * Tier 1: Public Catalog Repository
 * Unauthenticated / public reads for a tenant's published storefront, offerings, and bank accounts.
 * Strictly bounded by agency_id = tenantContext.agencyId AND is_published = true.
 * Requires authentic TenantContext or Request.
 */
export async function createPublicCatalogRepo(reqOrTenantContext, options = {}) {
  assertServerEnvironment();
  const tenantContext = await assertTrustedTenantInput(reqOrTenantContext, options);
  const client = _getScopedDbClient(tenantContext, options);
  const agencyId = tenantContext.agencyId;

  return {
    getAgencyId() {
      return agencyId;
    },

    getTenantContext() {
      return tenantContext;
    },

    async getAgencyInfo() {
      const [{ data: agency, error: agencyErr }, { data: profile, error: profileErr }] = await Promise.all([
        client
          .from("agencies")
          .select("id, slug, name, status")
          .eq("id", agencyId)
          .eq("status", "active")
          .maybeSingle(),
        client
          .from("agency_ui_profiles")
          .select("brand_name, logo_url, favicon_url, storefront_variant, checkout_variant, admin_variant, learner_variant, learning_variant, homework_variant, design_tokens, feature_flags")
          .eq("agency_id", agencyId)
          .maybeSingle()
      ]);

      if (agencyErr) throw agencyErr;
      if (profileErr) throw profileErr;
      if (!agency) return null;

      const p = profile || {};
      return {
        id: agency.id,
        slug: agency.slug,
        name: agency.name,
        status: agency.status,
        brand_name: p.brand_name || agency.name,
        logo_url: p.logo_url || null,
        favicon_url: p.favicon_url || null,
        storefront_variant: p.storefront_variant || "default",
        checkout_variant: p.checkout_variant || "default",
        admin_variant: p.admin_variant || "default",
        learner_variant: p.learner_variant || "default",
        learning_variant: p.learning_variant || "default",
        homework_variant: p.homework_variant || "default",
        design_tokens: p.design_tokens || {},
        feature_flags: p.feature_flags || {}
      };
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
  assertServerEnvironment();
  const authResult = await requireAgencyMembership(req, options);
  if (!authResult.ok) {
    return { ok: false, ...authResult };
  }

  const { user, membership, tenant } = authResult;
  const client = _getScopedDbClient(tenant, options);

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
        .select("id, agency_id, membership_id, offering_id, order_code, total_amount_vnd, status, snapshot_bank_code, snapshot_account_number, snapshot_account_holder, snapshot_transfer_content, created_at, updated_at")
        .eq("agency_id", tenant.agencyId)
        .eq("membership_id", membership.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data || [];
    },

    async getMyEntitlements() {
      const { data, error } = await client
        .from("student_entitlements")
        .select("id, agency_id, membership_id, canonical_course_id, status, expires_at, created_at")
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
 * Privileged mutations for agency staff and owners (e.g., managing offerings, banks).
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
  const client = _getScopedDbClient(tenant, options);
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
    }
  };

  return repo;
}

/**
 * Tier 4: Platform Core Read Repository
 * Read-only access to canonical curriculum (canonical_courses, canonical_lessons).
 * Enforces B4.3: PlatformCoreRead must prove the requested canonical course is actually
 * licensed to the current tenant via agency_offering_items.canonical_course_id.
 * Arbitrary ID access is denied.
 */
export async function createPlatformCoreReadRepo(reqOrTenantContext, options = {}) {
  assertServerEnvironment();
  const tenantContext = await assertTrustedTenantInput(reqOrTenantContext, options);
  const client = _getScopedDbClient(tenantContext, options);
  const agencyId = tenantContext.agencyId;

  return {
    async getCanonicalCourseByCode(courseCode) {
      if (!courseCode) return null;

      // 1. Fetch canonical course
      const { data: course, error } = await client
        .from("canonical_courses")
        .select("id, course_id, code, default_title, status, curriculum_metadata")
        .eq("code", courseCode.trim())
        .eq("status", "published")
        .maybeSingle();

      if (error) throw error;
      if (!course) return null;

      // 2. Enforce scope: Prove course is licensed through an offering of this agency
      // B4 FIX: Query agency_offering_items.canonical_course_id (NOT canonical_id)
      const { data: licensedItem, error: licError } = await client
        .from("agency_offering_items")
        .select("id")
        .eq("agency_id", agencyId)
        .eq("canonical_course_id", course.id)
        .limit(1)
        .maybeSingle();

      if (licError) throw licError;
      if (!licensedItem) {
        const scopeErr = new Error(`Access denied: Course '${courseCode}' is not licensed to current agency.`);
        scopeErr.status = 403;
        scopeErr.code = "course_not_licensed";
        throw scopeErr;
      }

      return course;
    },

    async getCanonicalLessons(canonicalCourseId) {
      if (!canonicalCourseId) return [];

      // 1. Enforce scope: Prove course is licensed through an offering of this agency
      // B4 FIX: Query agency_offering_items.canonical_course_id (NOT canonical_id)
      const { data: licensedItem, error: licError } = await client
        .from("agency_offering_items")
        .select("id")
        .eq("agency_id", agencyId)
        .eq("canonical_course_id", canonicalCourseId)
        .limit(1)
        .maybeSingle();

      if (licError) throw licError;
      if (!licensedItem) {
        const scopeErr = new Error(`Access denied: Canonical course '${canonicalCourseId}' is not licensed to current agency.`);
        scopeErr.status = 403;
        scopeErr.code = "course_not_licensed";
        throw scopeErr;
      }

      // 2. Fetch canonical lessons
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
 * Scoped Agency Order Operations (replaces raw service client escape).
 * Exposes only narrow, strictly bounded operations for orders:
 * - createOrder
 * - approveOrder
 * - refundOrder
 * Caller NEVER receives raw service-role Supabase client.
 */
export const agencyOrderOperations = Object.freeze({
  async createOrder(req, payload, options = {}) {
    assertServerEnvironment();
    const { checkoutOffering } = await import("./agency-commerce.js");
    return checkoutOffering(req, payload, options);
  },

  async approveOrder(req, orderId, options = {}) {
    assertServerEnvironment();
    const { approveAgencyOrder } = await import("./agency-commerce.js");
    return approveAgencyOrder(req, orderId, options);
  },

  async refundOrder(req, orderId, reason, options = {}) {
    assertServerEnvironment();
    const { refundAgencyOrder } = await import("./agency-commerce.js");
    return refundAgencyOrder(req, orderId, reason, options);
  }
});

/**
 * Scoped Agency Homework Operations (replaces raw service client escape).
 * Exposes only narrow, strictly bounded operations for homework:
 * - submitHomework
 * - gradeHomework
 * Caller NEVER receives raw service-role Supabase client.
 */
export const agencyHomeworkOperations = Object.freeze({
  async submitHomework(req, payload, options = {}) {
    assertServerEnvironment();
    const { submitAgencyHomework } = await import("./agency-homework.js");
    return submitAgencyHomework(req, payload, options);
  },

  async gradeHomework(req, payload, options = {}) {
    assertServerEnvironment();
    const { gradeAgencyHomework } = await import("./agency-homework.js");
    return gradeAgencyHomework(req, payload, options);
  }
});
