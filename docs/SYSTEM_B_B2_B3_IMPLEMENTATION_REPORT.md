# System B Milestone B2.1 & B3.1 Security Patch & Implementation Report

**Authoritative Plan**: `SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md`  
**Target Database**: Main Supabase (`yyiavtiwtekkocqpephr`)  
**Scope**: Milestone B2.1 & B3.1 Security Remediation (Fixing 4 Blocking Review Findings Before B4)  
**Date**: September 26, 2026  
**Status**: **PASS (REMEDIATED & READY FOR RE-REVIEW)**  

---

## 1. Executive Summary & Review Gate Context

Following external ChatGPT Work security review (`B2_B3_REVIEW = NEEDS_FIX`), four blocking security findings were remediated under strict scope boundaries:

1. **Blocker 1 (Auth Guard Request Tenant Binding)**: `requireAgencyMembership` and `requireAgencyRole` in `utils/agency-auth.js` previously accepted plain objects with `{ agencyId }`. They now require an unforgeably branded `TenantContext` issued by `tenant-resolver` (`isTrustedTenantContext`) AND strictly verify that `tenantContext.hostname` matches the trusted hostname derived from the **same** HTTP request (`getTrustedHost(req)`). Fabricated contexts or cross-tenant context reuse are rejected immediately.
2. **Blocker 2 (Role Allowlist Fail-Closed)**: `requireAgencyRole` previously permitted any active member if `allowedRoles` was empty or missing. It now strictly enforces a non-empty, valid array of role strings (`invalid_role_configuration`), failing closed on `undefined`, `null`, `[]`, or non-array inputs.
3. **Blocker 3 (Host Authority & Forwarded Host Conflict Rejection)**: `getTrustedHost` in `utils/tenant-resolver.js` previously allowed a single `x-forwarded-host` to override `host`. The routed `host` header is now the sole tenant authority. If `x-forwarded-host` is present, it is validated; if it conflicts with `host` or is malformed, the request is denied immediately (`AMBIGUOUS_FORWARDED_HOST = DENY`, `B3_FORWARDED_HOST_CONFLICT = DENY`) without silent fallback.
4. **Blocker 4 (Strict Full Authority Parsing)**: `normalizeHost` previously split at the first colon without validating the remainder of the authority. It now validates the entire authority string: hostnames must conform strictly to RFC 1123, and optional ports must be numeric digits within `1..65535` with no leading zeros. Any trailing garbage (`agency.example:garbage`, `agency.example:443:bad`), internal spaces, URI schemes, paths, slashes, or IPv6 brackets immediately fail closed.

---

## 2. Milestone B2.1: Global Identity & Membership Authorization

### 2.1 Remediations Applied
- **Unforgeable Tenant Brand**: `utils/tenant-resolver.js` maintains a private `WeakSet` (`trustedContextSet`). Only genuine contexts constructed by `resolveTenant` are branded. Fabricated objects `{ agencyId: "B" }` return `false` on `isTrustedTenantContext` and are rejected with `HTTP 403 untrusted_tenant_context`.
- **Request Host Binding**: `requireAgencyMembership` extracts the trusted host from `req` and asserts `tenantContext.hostname === requestHost`. If a caller presents a genuine context for Agency B on a request routed to Agency A, access is denied with `HTTP 403 tenant_host_mismatch`.
- **Dual-Agency Scoping**: When a user holds dual memberships (e.g. `student` in Agency Alpha, `agency_staff` in Agency Beta), the active tenant is strictly anchored to the request's host header. On Agency Alpha's domain, the caller can never exercise Agency Beta's staff privileges.
- **Fail-Closed Role Allowlist**: `requireAgencyRole(req, tenantContext, allowedRoles, options)` verifies that `allowedRoles` is an array of non-empty strings with `length > 0`. Missing or empty lists return `HTTP 500 invalid_role_configuration`. General access open to all members must explicitly use `requireAgencyMembership`.

---

## 3. Milestone B3.1: Trusted Host & Full Authority Validation

### 3.1 Remediations Applied
- **Host as Sole Authority**: `req.headers["host"]` is the authoritative tenant source.
- **Forwarded Host Conflict & Malformation Guard**:
  - `host = A`, `x-forwarded-host = A` => Accept A.
  - `host = A`, `x-forwarded-host = B` => DENY (`B3_FORWARDED_HOST_CONFLICT = DENY`).
  - `host = A`, `x-forwarded-host = "garbage!#$"` => DENY (no silent fallback).
  - `host = A`, `x-forwarded-host` absent => Accept A.
- **Full Authority Parsing**:
  - Authority syntax must match `hostname` or `hostname:port`.
  - Port validation: `/^[0-9]{1,5}$/`, `1 <= port <= 65535`, `String(portNum) === portPart` (disallows leading zeros like `0443`).
  - Prohibits multiple colons (`host:443:bad`), internal whitespace, userinfo (`@`), URI query/hash (`?`, `#`), slashes (`/`, `\\`), and IPv6 brackets (`[`, `]`).
  - FQDN trailing dot (e.g. `agency.example.`) is safely stripped only after full syntax validation.
- **Multi-Header / Array Rejection**:
  - Array-valued `host` or `x-forwarded-host` headers fail closed (`HTTP 400 invalid_host`).
  - Comma-separated values fail closed.
- **Spoof Guards**: Untrusted headers (`x-agency-id`, `x-agency-slug`, `x-trusted-agency-id`, `x-tenant-id`) are completely ignored.

---

## 4. Database Migrations & Invariants

- **New Database Migrations**: `0` (Existing migration `20260926170000_multi_agency_b2_identity_and_tenant_domain.sql` remained completely valid and unchanged).
- **V5 Runtime Mutations**: `NO` (V5 playback protocol, lease format, P-256 signatures, Worker, and R2 untouched).
- **R2 Mutations**: `0`.
- **Legacy Supabase Mutations**: `0`.
- **B4 Status**: `NOT_STARTED`.

---

## 5. Automated Verification Test Suite

### 5.1 Unit & Integration Suite (`test/multi-agency-b2-b3.test.js`)
Executed across both `yeunauan-lms-clone` and `yeunauan-commerce-clone`:

| Test Identifier | Category / Requirement | Verdict |
|---|---|:---:|
| `B3.1-AUTH-VALID` | Valid authorities normalize cleanly (`agency.example`, `:443`, trailing dot, localhost) | **PASS** |
| `B3.1-AUTH-PORT-DENY` | Malformed port values fail closed (non-numeric, range violation, leading zero) | **PASS** |
| `B3.1-AUTH-SYNTAX-DENY` | Malformed authority, URI schemes, paths, internal spaces, IPv6 fail closed | **PASS** |
| `B3.1-HOST-AUTH` | Host header is tenant authority (matching forwarded host or absent forwarded host) | **PASS** |
| `B3.1-FORWARDED-CONFLICT` | Conflicting forwarded host denied (`host: A`, `x-forwarded-host: B`) | **PASS** |
| `B3.1-FORWARDED-MALFORMED` | Malformed forwarded host denied without silent fallback to host | **PASS** |
| `B3.1-ARRAY-HEADERS-DENY` | Array-valued `host` or `x-forwarded-host` denied | **PASS** |
| `B3.1-SPOOF-GUARD` | Untrusted tenant headers (`x-agency-*`) have zero effect | **PASS** |
| `B3.1-UNKNOWN-HOST` | Unknown host fails closed (HTTP 404 `tenant_not_found`) | **PASS** |
| `B3.1-INACTIVE-DOMAIN` | Inactive domain or agency fails closed (HTTP 404 `tenant_not_found`) | **PASS** |
| `B3.1-RESOLVE-ACTIVE` | Valid active host resolves immutable, trusted `TenantContext` | **PASS** |
| `B3.1-CACHE-ISOLATION` | In-memory tenant cache prevents cross-tenant bleed | **PASS** |
| `B2.1-FABRICATED-CONTEXT-DENY` | Fabricated `TenantContext` (`{ agencyId }`) cannot authorize (HTTP 403 `untrusted_tenant_context`) | **PASS** |
| `B2.1-HOST-MISMATCH-DENY` | `TenantContext` / request hostname mismatch denied (HTTP 403 `tenant_host_mismatch`) | **PASS** |
| `B2.1-REAL-CONTEXT-ALLOWED` | Real resolver context + matching request host allowed | **PASS** |
| `B2.1-DUAL-AGENCY-HOST-SCOPE` | Dual-agency user correctly scoped by request host | **PASS** |
| `B2.1-ROLE-ALLOWLIST-FAIL-CLOSED` | Missing, empty, or non-array `allowedRoles` fails closed (HTTP 500 `invalid_role_configuration`) | **PASS** |
| `B2.1-ROLE-ENFORCEMENT` | Role permissions allow/deny strictly according to allowlist | **PASS** |
| `B2.1-AUTH-NO-SESSION` | Rejects missing session (HTTP 401 `unauthenticated`) | **PASS** |
| `B2.1-LEGACY-HMAC-DENIED` | Rejects old legacy HMAC session token on new agency path | **PASS** |
| `B2.1-EXPIRED-SESSION` | Rejects expired or invalid Supabase JWT | **PASS** |
| `B2.1-MEMBERSHIP-SUSPENDED` | Suspended membership is denied (HTTP 403 `membership_suspended`) | **PASS** |

**Summary**: 22 tests executed, 22 passed, 0 failed.

---

### 5.2 Real PostgREST Signed-JWT RPC Exit Gate
Executed via `scripts/test-real-postgrest-jwt.js` against live Main Supabase (`https://yyiavtiwtekkocqpephr.supabase.co`):
- All 7 scenarios passed:
  - Scenario 1 (Valid JWT + membership): PASS
  - Scenario 2 (Another user's membership UUID): PASS (`invalid_membership`)
  - Scenario 3 (Wrong agency): PASS (`agency_membership_not_found`)
  - Scenario 4 (Expired/tampered JWT): PASS (HTTP 401)
  - Scenario 5 (Anonymous call without JWT): PASS (HTTP 401 / permission denied)
  - Scenario 6 (Spoofed headers): PASS (Caller derived strictly from JWT `auth.uid()`)
  - Scenario 7 (Domain RPC resolution): PASS (`found: true`)
- Verdict: `POSTGREST_SIGNED_JWT_RPC_TEST = PASS`

---

### 5.3 Secret Pattern Scanning
Executed `scripts/scan-secrets.py` on all modified files across both repositories.
- Result: **PASS: No secret patterns detected.**

---

## 6. Review Gate Handover Scorecard

```text
B2_1_REQUEST_TENANT_BINDING = PASS
B2_1_ROLE_ALLOWLIST_FAIL_CLOSED = PASS
B2_1_MULTI_AGENCY_HOST_SCOPE = PASS

B3_1_HOST_AUTHORITY = PASS
B3_1_FORWARDED_HOST_CONFLICT = DENY
B3_1_FULL_AUTHORITY_VALIDATION = PASS
B3_1_AMBIGUOUS_HOST_REJECTION = PASS
B3_1_TENANT_SPOOF_GUARD = PASS

LMS_TESTS = 22/22 PASS
COMMERCE_TESTS = 22/22 PASS

VERCEL_HOST_BOUNDARY_TEST = DEFERRED_BEFORE_M0C

DB_MIGRATIONS_ADDED = 0
V5_RUNTIME_CHANGED = NO
R2_MUTATIONS = 0
LEGACY_MUTATIONS = 0

LMS_REVIEW_HEAD_SHA = <committed below>
COMMERCE_REVIEW_HEAD_SHA = <committed below>
REMOTE_PUSH = PASS

B2_1_STATUS = PASS
B3_1_STATUS = PASS

B4_NOT_STARTED = YES
```
