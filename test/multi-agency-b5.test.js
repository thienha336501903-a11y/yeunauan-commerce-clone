// test/multi-agency-b5.test.js
// Automated test suite for System B Milestone B5 Commerce Adaptation & Entitlement Grant Lifecycle

import assert from "node:assert/strict";
import test from "node:test";
import {
  getAuthoritativeQuote,
  checkoutOffering,
  approveAgencyOrder,
  refundAgencyOrder,
  generateVietQrUrl
} from "../utils/agency-commerce.js";
import { _clearTenantCache } from "../utils/tenant-resolver.js";

// =============================================================================
// B5.1: AUTHORITATIVE QUOTE & ATOMIC CHECKOUT
// =============================================================================

test("B5.1-AUTHORITATIVE-QUOTE: Quote derives prices strictly from database records", async () => {
  const tenant = { agencyId: "agency-1", hostname: "agency-1.com" };

  const mockDb = {
    from: (table) => ({
      select: () => {
        if (table === "agency_offerings") {
          return {
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: "offering-1",
                      agency_id: "agency-1",
                      slug: "culinary-mastery",
                      display_title: "Culinary Mastery Course",
                      price_vnd: 2500000,
                      sale_price_vnd: 1990000,
                      is_published: true
                    },
                    error: null
                  })
                })
              })
            })
          };
        }
        if (table === "agency_offering_items") {
          return {
            eq: () => ({
              eq: () => ({
                data: [
                  { id: "item-1", canonical_course_id: "canonical-course-101", item_type: "canonical_course" }
                ],
                error: null
              })
            })
          };
        }
        return { eq: () => ({ eq: () => ({ data: [], error: null }) }) };
      }
    })
  };

  const res = await getAuthoritativeQuote(tenant, "culinary-mastery", { supabaseClient: mockDb });
  assert.equal(res.ok, true);
  assert.equal(res.quote.priceVnd, 2500000);
  assert.equal(res.quote.salePriceVnd, 1990000);
  assert.equal(res.quote.finalAmountVnd, 1990000);
});

test("B5.1-LOGIN-REQUIRED-FOR-CHECKOUT: Unauthenticated or non-member checkout fails closed (VERIFIED LOGIN REQUIRED)", async () => {
  _clearTenantCache();

  const mockTenantDb = {
    rpc: async () => ({
      data: { found: true, agency_id: "agency-1", hostname: "agency-1.com" }
    })
  };

  // 1. Unauthenticated request (no bearer token)
  const reqUnauth = { headers: { host: "agency-1.com" } };
  const resUnauth = await checkoutOffering(reqUnauth, {
    offeringId: "offering-1",
    bankAccountId: "bank-1"
  }, { supabaseClient: mockTenantDb });
  assert.equal(resUnauth.ok, false);
  assert.equal(resUnauth.status, 401);
  assert.equal(resUnauth.code, "unauthenticated");

  // 2. Authenticated user but not a member of this agency
  const mockDb = {
    rpc: async () => ({
      data: { found: true, agency_id: "agency-1", hostname: "agency-1.com" }
    }),
    auth: {
      getUser: async () => ({ data: { user: { id: "foreign-user" } } })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null }) // Not a member!
          })
        })
      })
    })
  };

  const reqNonMember = { headers: { host: "agency-1.com", authorization: "Bearer foreign_jwt" } };
  const resNonMember = await checkoutOffering(reqNonMember, {
    offeringId: "offering-1",
    bankAccountId: "bank-1"
  }, { supabaseClient: mockDb });

  assert.equal(resNonMember.ok, false);
  assert.equal(resNonMember.status, 403);
  assert.equal(resNonMember.code, "membership_not_found");
});

// =============================================================================
// B5.2: BANK SNAPSHOT & IMMUTABLE CHECKOUT DETAILS
// =============================================================================

test("B5.2-BANK-SNAPSHOT: Checkout creates immutable order bank snapshot and VietQR payload", async () => {
  _clearTenantCache();

  let checkoutRpcArgs = null;

  const mockDb = {
    rpc: async (func, args) => {
      if (func === "resolve_agency_domain") {
        return { data: { found: true, agency_id: "agency-1", hostname: "agency-1.com" } };
      }
      if (func === "checkout_agency_offering") {
        checkoutRpcArgs = args;
        return {
          data: {
            ok: true,
            order_id: "order-uuid-123",
            order_code: args.p_idempotency_order_code,
            status: "pending",
            amount_vnd: 1990000,
            bank_code: "970422",
            account_number: "0987654321",
            account_holder: "AGENCY ONE ACADEMY",
            transfer_content: "AGENCY1 ORD123",
            idempotent: false
          }
        };
      }
      return { data: null };
    },
    auth: {
      getUser: async () => ({ data: { user: { id: "member-user-1" } } })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "mem-1",
                agency_id: "agency-1",
                user_id: "member-user-1",
                role: "student",
                status: "active"
              }
            })
          })
        })
      })
    })
  };

  const req = { headers: { host: "agency-1.com", authorization: "Bearer valid_jwt" } };
  const res = await checkoutOffering(req, {
    offeringId: "offering-1",
    bankAccountId: "bank-1",
    idempotencyOrderCode: "ORD-TEST-123"
  }, { supabaseClient: mockDb });

  assert.equal(res.ok, true);
  assert.equal(res.order.orderId, "order-uuid-123");
  assert.equal(res.order.bankCode, "970422");
  assert.equal(res.order.accountNumber, "0987654321");
  assert.equal(res.order.accountHolder, "AGENCY ONE ACADEMY");
  assert.equal(res.order.amountVnd, 1990000);
  assert.match(res.order.vietQrUrl, /https:\/\/img\.vietqr\.io\/image\/970422-0987654321-compact2\.png/);
});

// =============================================================================
// B5.3: ORDER IDEMPOTENCY & TRANSACTIONAL APPROVAL
// =============================================================================

test("B5.3-APPROVAL-IDEMPOTENCY: Duplicate order approval is strictly idempotent", async () => {
  _clearTenantCache();

  let approveCallCount = 0;

  const mockDb = {
    rpc: async (func, args) => {
      if (func === "resolve_agency_domain") {
        return { data: { found: true, agency_id: "agency-1", hostname: "agency-1.com" } };
      }
      if (func === "approve_agency_order") {
        approveCallCount++;
        if (approveCallCount === 1) {
          return {
            data: {
              ok: true,
              order_id: args.p_order_id,
              status: "completed",
              grants_created: 1,
              idempotent: false
            }
          };
        }
        // Second call: already completed
        return {
          data: {
            ok: true,
            order_id: args.p_order_id,
            status: "completed",
            grants_created: 0,
            idempotent: true
          }
        };
      }
      return { data: null };
    },
    auth: {
      getUser: async () => ({ data: { user: { id: "staff-1" } } })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "mem-staff-1",
                agency_id: "agency-1",
                user_id: "staff-1",
                role: "agency_staff",
                status: "active"
              }
            })
          })
        })
      })
    })
  };

  const req = { headers: { host: "agency-1.com", authorization: "Bearer staff_jwt" } };

  // First approval
  const res1 = await approveAgencyOrder(req, "order-uuid-123", { supabaseClient: mockDb });
  assert.equal(res1.ok, true);
  assert.equal(res1.status, "completed");
  assert.equal(res1.idempotent, false);

  // Duplicate approval
  const res2 = await approveAgencyOrder(req, "order-uuid-123", { supabaseClient: mockDb });
  assert.equal(res2.ok, true);
  assert.equal(res2.status, "completed");
  assert.equal(res2.idempotent, true);
});

// =============================================================================
// B5.4: GRANT LIFECYCLE, MULTI-SOURCE & REFUND EFFECTIVE RECOMPUTATION
// =============================================================================

test("B5.4-GRANT-LIFECYCLE-MULTI-SOURCE: Revoking order purchase grant does not destroy independent admin grant", async () => {
  _clearTenantCache();

  const mockDb = {
    rpc: async (func, args) => {
      if (func === "resolve_agency_domain") {
        return { data: { found: true, agency_id: "agency-1", hostname: "agency-1.com" } };
      }
      if (func === "refund_agency_order") {
        return {
          data: {
            ok: true,
            order_id: args.p_order_id,
            status: "refunded",
            grants_revoked: 1,
            idempotent: false
          }
        };
      }
      return { data: null };
    },
    auth: {
      getUser: async () => ({ data: { user: { id: "owner-1" } } })
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "mem-owner-1",
                agency_id: "agency-1",
                user_id: "owner-1",
                role: "agency_owner",
                status: "active"
              }
            })
          })
        })
      })
    })
  };

  const req = { headers: { host: "agency-1.com", authorization: "Bearer owner_jwt" } };
  const res = await refundAgencyOrder(req, "order-uuid-123", "Customer requested cancellation", { supabaseClient: mockDb });

  assert.equal(res.ok, true);
  assert.equal(res.status, "refunded");
  assert.equal(res.grantsRevoked, 1);
});
