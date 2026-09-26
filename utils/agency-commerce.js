// utils/agency-commerce.js
// System B Milestone B5 — Agency Commerce, Authoritative Quote, Bank Snapshot & Grant Lifecycle
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Milestone M0B.1 / Pre-M0C Remediation V2 Hardened Implementation

import { supabase as defaultSupabase } from "./supabase.js";
import { resolveTenant, isTrustedTenantContext } from "./tenant-resolver.js";
import { requireAgencyMembership, requireAgencyRole } from "./agency-auth.js";
import { assertServerEnvironment, assertTrustedTenantInput } from "./tenant-db-resolver.js";

/**
 * Generates VietQR payment URL.
 */
export function generateVietQrUrl(bankCode, accountNumber, amount, transferContent) {
  if (!bankCode || !accountNumber) return null;
  const encodedContent = encodeURIComponent(transferContent || "");
  return `https://img.vietqr.io/image/${bankCode}-${accountNumber}-compact2.png?amount=${amount}&addInfo=${encodedContent}`;
}

/**
 * Internal private helper for acquiring database client.
 * Enforces server environment and trusted TenantContext.
 */
function _getCommerceDbClient(tenantContext, options = {}) {
  assertServerEnvironment();
  if (!tenantContext || !isTrustedTenantContext(tenantContext)) {
    throw new Error("SECURITY VIOLATION: Commerce operations require a verified TenantContext issued by tenant-resolver.");
  }
  return options.supabaseClient || defaultSupabase;
}

/**
 * Returns public commerce configuration for a tenant storefront.
 */
export async function getAgencyCommerceConfig(reqOrTenantContext, options = {}) {
  const tenantContext = await assertTrustedTenantInput(reqOrTenantContext, options);
  const client = _getCommerceDbClient(tenantContext, options);
  const agencyId = tenantContext.agencyId;

  const [agencyRes, profileRes, banksRes, offeringsRes] = await Promise.all([
    client.from("agencies")
      .select("id, slug, name")
      .eq("id", agencyId)
      .eq("status", "active")
      .maybeSingle(),
    client.from("agency_ui_profiles")
      .select("brand_name, logo_url, favicon_url, storefront_variant, checkout_variant, admin_variant, learner_variant, learning_variant, homework_variant, design_tokens, feature_flags")
      .eq("agency_id", agencyId)
      .maybeSingle(),
    client.from("agency_bank_accounts")
      .select("id, bank_code, account_number, account_holder, branch")
      .eq("agency_id", agencyId)
      .eq("is_active", true),
    client.from("agency_offerings")
      .select("id, slug, display_title, display_description, thumbnail_url, price_vnd, sale_price_vnd, sort_order")
      .eq("agency_id", agencyId)
      .eq("is_published", true)
      .order("sort_order", { ascending: true })
  ]);

  if (agencyRes.error) throw agencyRes.error;
  if (profileRes.error) throw profileRes.error;
  if (!agencyRes.data) {
    return { ok: false, status: 404, code: "agency_not_found", error: "Agency not found or inactive" };
  }

  const profile = profileRes.data || {};
  const agencyData = {
    id: agencyRes.data.id,
    slug: agencyRes.data.slug,
    name: agencyRes.data.name,
    brand_name: profile.brand_name || agencyRes.data.name,
    logo_url: profile.logo_url || null,
    favicon_url: profile.favicon_url || null,
    storefront_variant: profile.storefront_variant || "default",
    checkout_variant: profile.checkout_variant || "default",
    admin_variant: profile.admin_variant || "default",
    learner_variant: profile.learner_variant || "default",
    learning_variant: profile.learning_variant || "default",
    homework_variant: profile.homework_variant || "default",
    design_tokens: profile.design_tokens || {},
    feature_flags: profile.feature_flags || {}
  };

  return {
    ok: true,
    agency: agencyData,
    banks: banksRes.data || [],
    offerings: offeringsRes.data || []
  };
}

/**
 * Returns authoritative server quote for an offering.
 * Prices and discounts are derived strictly from database records.
 * Browser-supplied prices are completely ignored.
 */
export async function getAuthoritativeQuote(reqOrTenantContext, offeringSlug, options = {}) {
  const tenantContext = await assertTrustedTenantInput(reqOrTenantContext, options);
  const client = _getCommerceDbClient(tenantContext, options);

  const { data: offering, error } = await client
    .from("agency_offerings")
    .select("id, agency_id, slug, display_title, display_description, thumbnail_url, price_vnd, sale_price_vnd, is_published")
    .eq("agency_id", tenantContext.agencyId)
    .eq("slug", offeringSlug)
    .eq("is_published", true)
    .maybeSingle();

  if (error) throw error;
  if (!offering) {
    return { ok: false, status: 404, code: "offering_not_found", error: "Offering not found or unavailable." };
  }

  // Get items included in this offering (supports single course or multi-course bundle)
  const { data: items, error: itemsErr } = await client
    .from("agency_offering_items")
    .select("id, canonical_course_id, item_type")
    .eq("agency_id", tenantContext.agencyId)
    .eq("offering_id", offering.id);

  if (itemsErr) throw itemsErr;

  const finalAmountVnd = offering.sale_price_vnd !== null && offering.sale_price_vnd !== undefined
    ? Number(offering.sale_price_vnd)
    : Number(offering.price_vnd);

  return {
    ok: true,
    quote: {
      offeringId: offering.id,
      slug: offering.slug,
      title: offering.display_title,
      priceVnd: Number(offering.price_vnd),
      salePriceVnd: offering.sale_price_vnd ? Number(offering.sale_price_vnd) : null,
      finalAmountVnd,
      currency: "VND",
      items: items || []
    }
  };
}

/**
 * Initiates checkout for an offering.
 * Strict owner rule: VERIFIED LOGIN REQUIRED BEFORE CHECKOUT (No guest checkout).
 * Server-side bank selection: Browser does NOT select bank account ID;
 * Server derives active/default bank authoritatively from database routing rule.
 * Creates pending order with immutable bank details and VietQR payment information.
 */
export async function checkoutOffering(req, checkoutPayload, options = {}) {
  assertServerEnvironment();

  // 1. Authenticate user and active membership in current request tenant
  const authResult = await requireAgencyMembership(req, options);
  if (!authResult.ok) {
    return authResult; // 401 if unauthenticated, 403 if not member
  }

  const { user, membership, tenant } = authResult;
  const client = _getCommerceDbClient(tenant, options);

  const { offeringId, idempotencyOrderCode } = checkoutPayload || {};
  if (!offeringId) {
    return {
      ok: false,
      status: 400,
      code: "invalid_checkout_payload",
      error: "offeringId is required for checkout."
    };
  }

  // B5 2A: Browser has zero authority over bank destination. Client bankAccountId is ignored.
  const orderCode = idempotencyOrderCode || `ORD-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;

  // 2. Call authoritative checkout RPC (bank is auto-derived server-side)
  const { data, error } = await client.rpc("checkout_agency_offering", {
    p_agency_id: tenant.agencyId,
    p_membership_id: membership.id,
    p_offering_id: offeringId,
    p_bank_account_id: null, // Strictly server-routed bank account
    p_idempotency_order_code: orderCode
  });

  if (error) {
    console.error("[agency-commerce] Checkout RPC error:", error);
    return { ok: false, status: 500, code: "checkout_error", error: error.message };
  }

  if (!data.ok) {
    const status = data.code === "idempotency_ownership_conflict" ? 409 : 400;
    return { ok: false, status, code: data.code, error: data.error };
  }

  // 3. Generate VietQR URL from stored immutable snapshot
  const vietQrUrl = generateVietQrUrl(
    data.bank_code,
    data.account_number,
    data.amount_vnd,
    data.transfer_content
  );

  return {
    ok: true,
    order: {
      orderId: data.order_id,
      orderCode: data.order_code,
      status: data.status,
      amountVnd: data.amount_vnd,
      bankCode: data.bank_code,
      accountNumber: data.account_number,
      accountHolder: data.account_holder,
      transferContent: data.transfer_content,
      vietQrUrl,
      idempotent: data.idempotent
    }
  };
}

/**
 * Approves a pending agency order and grants course entitlements.
 * Only agency staff or agency owner can approve orders.
 * Transactional, deterministic lock order, and idempotent.
 */
export async function approveAgencyOrder(req, orderId, options = {}) {
  assertServerEnvironment();

  // Authorize agency staff or owner
  const roleResult = await requireAgencyRole(req, ["agency_staff", "agency_owner"], options);
  if (!roleResult.ok) {
    return roleResult;
  }

  const { membership, tenant } = roleResult;
  const client = _getCommerceDbClient(tenant, options);

  const { data, error } = await client.rpc("approve_agency_order", {
    p_agency_id: tenant.agencyId,
    p_order_id: orderId,
    p_approved_by_membership_id: membership.id
  });

  if (error) {
    console.error("[agency-commerce] Approve order error:", error);
    return { ok: false, status: 500, code: "approval_error", error: error.message };
  }

  if (!data.ok) {
    return { ok: false, status: 400, code: data.code, error: data.error };
  }

  return {
    ok: true,
    orderId: data.order_id,
    status: data.status,
    grantsCreated: data.grants_created,
    idempotent: data.idempotent
  };
}

/**
 * Refunds an order and revokes associated entitlement grants.
 * Strict state machine: Only completed/approved orders can be refunded.
 * Only agency staff or agency owner can refund orders.
 * Recomputes effective entitlements with row-level parent locking.
 */
export async function refundAgencyOrder(req, orderId, reason = "Customer refund", options = {}) {
  assertServerEnvironment();

  const roleResult = await requireAgencyRole(req, ["agency_staff", "agency_owner"], options);
  if (!roleResult.ok) {
    return roleResult;
  }

  const { tenant } = roleResult;
  const client = _getCommerceDbClient(tenant, options);

  const { data, error } = await client.rpc("refund_agency_order", {
    p_agency_id: tenant.agencyId,
    p_order_id: orderId,
    p_reason: reason
  });

  if (error) {
    console.error("[agency-commerce] Refund order error:", error);
    return { ok: false, status: 500, code: "refund_error", error: error.message };
  }

  if (!data.ok) {
    return { ok: false, status: 400, code: data.code, error: data.error };
  }

  return {
    ok: true,
    orderId: data.order_id,
    status: data.status,
    grantsRevoked: data.grants_revoked,
    idempotent: data.idempotent
  };
}
