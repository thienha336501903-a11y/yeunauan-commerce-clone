# System B Milestone B2 & B3 Implementation & Security Verification Report

**Authoritative Plan**: `SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md`  
**Target Database**: Main Supabase (`yyiavtiwtekkocqpephr`)  
**Scope**: Milestone B2 (Global Identity + Agency Membership Authorization) & Milestone B3 (Trusted Host / Tenant Resolver) ONLY  
**Date**: September 26, 2026  
**Status**: **PASS (READY FOR EXTERNAL CHATGPT WORK SECURITY REVIEW GATE)**  

---

## 1. Executive Summary

Milestones B2 and B3 establish the core identity, multi-agency membership authorization, and host-driven tenant resolution layers for System B's additive Multi-Agency architecture.

- **B2 (Global Identity + Agency Membership Authorization)**: All authentication is strictly anchored in Supabase Auth (`auth.users`), with cryptographic JWTs verified at the PostgREST boundary. Multi-agency scoping is enforced strictly via database queries on `agency_memberships` keyed by `auth.uid()`, preventing `user_metadata` role tampering, session hijacking, or cross-tenant identity bleed. Legacy HMAC session tokens are explicitly rejected on agency paths.
- **B3 (Trusted Host / Tenant Resolver)**: Tenant identity is strictly derived from the incoming HTTP host header (`x-forwarded-host` with strict single-value precedence over `host`). Ambiguous, comma-separated headers, URI schemes, paths, and malformed hostnames fail closed immediately. Spoofed tenant headers (`x-agency-id`, `x-agency-slug`, `x-trusted-agency-id`, `x-tenant-id`) are completely ignored. Database domain resolution is performed via the secure RPC `public.resolve_agency_domain(p_hostname TEXT)`.
- **PostgREST Real Signed-JWT Exit Gate**: 7 out of 7 real HTTPS PostgREST scenarios passed against live Main Supabase (`https://yyiavtiwtekkocqpephr.supabase.co`), verifying that `v5_authorize_agency_playback` enforces cryptographic caller binding (`auth.uid()`) and cannot be spoofed.

---

## 2. Milestone B2: Global Identity & Membership Authorization

### 2.1 Architectural Invariants
1. **Single Authoritative Identity Provider**: All user accounts exist in `auth.users`. No separate shadow user tables or custom password hashes are used for agencies.
2. **Foreign Key Binding**: `agency_memberships.user_id` strictly references `auth.users(id)` with an explicit foreign key (`fk_agency_memberships_user_id`) and index (`idx_agency_memberships_user_id`).
3. **Database-Driven Roles**: The user's role (`agency_owner`, `agency_staff`, `student`) is stored exclusively in `agency_memberships.role`. Client-controllable JWT metadata (`user_metadata`, `app_metadata` if client-writable) is completely ignored during authorization checks.
4. **Multi-Agency Scoping**: A single global user can hold independent roles across multiple agencies (e.g. `student` in Agency Alpha, `agency_staff` in Agency Beta) with complete isolation.
5. **Fail-Closed Membership Status**: Any membership with status `suspended` or `banned` is denied access immediately.
6. **Rejection of Legacy HMAC Tokens**: Legacy admin HMAC session tokens (e.g. `admin_session_token` cookie) are rejected on all agency paths (`legacy_auth_rejected`).

### 2.2 Core Module: `utils/agency-auth.js`
- `extractAuthToken(req)`: Safely parses `Authorization: Bearer <token>` while rejecting empty, malformed, or legacy HMAC tokens.
- `requireAuthenticatedUser(req, options)`: Validates Supabase JWT against GoTrue/PostgREST. Returns verified user principal.
- `requireAgencyMembership(req, tenantContext, options)`: Strictly resolves caller's membership in the target agency via `user_id = auth.uid() AND agency_id = tenantContext.agencyId`. Checks status (`active`).
- `requireAgencyRole(req, tenantContext, allowedRoles, options)`: Enforces role permissions against verified database record.

---

## 3. Milestone B3: Trusted Host / Tenant Resolver

### 3.1 Architectural Invariants
1. **Host Extraction & Precedence**:
   - `x-forwarded-host` takes precedence ONLY if it contains a single, valid hostname.
   - Ambiguous, comma-separated forwarded hosts (`proxy chaining` or header injection) fail closed immediately (`AMBIGUOUS_FORWARDED_HOST = DENY`).
   - Slashes, backslashes, and URI schemes (`://`) are rejected before parsing to prevent path/URL spoofing.
   - Falls back to `host` header.
2. **Strict Host Normalization**:
   - Lowercases hostname.
   - Strips port (e.g. `:3000`, `:443`).
   - Strips trailing FQDN root dots.
   - Validates against RFC 1123 domain label regex: `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/`.
3. **Zero Untrusted Header Consultations**:
   - Client-supplied `x-agency-id`, `x-agency-slug`, `x-trusted-agency-id`, `x-tenant-id`, query params, or body fields are never used to determine tenant identity (`X_AGENCY_ID_SPOOF = NO EFFECT`).
4. **Database Domain Resolution RPC**:
   - Added `status` column (`active`, `inactive`, `archived`) to `agency_domains`.
   - RPC `public.resolve_agency_domain(p_hostname TEXT)` queries `agency_domains` and `agencies` using `SECURITY DEFINER` and safe `search_path = public, pg_temp`.
   - Requires both agency `status = 'active'` AND domain `status = 'active'`. Inactive domains or agencies fail closed (`UNKNOWN_HOST = DENY`).
5. **In-Memory Tenant Context & Caching**:
   - Normalization key caching with positive TTL (60s) and negative TTL (5s to prevent hammering).
   - Produces an immutable, `Object.freeze()` `TenantContext` containing `{ agencyId, agencySlug, agencyName, hostname, domainId, isPrimary, surface }`.
   - Complete cache isolation prevents cross-tenant bleed.

---

## 4. Applied Database Migrations

### Migration `20260926170000_multi_agency_b2_identity_and_tenant_domain.sql`
- **Location**: `yeunauan-lms-clone/supabase/migrations/20260926170000_multi_agency_b2_identity_and_tenant_domain.sql`
- **Applied To**:
  - Local PostgreSQL 17.6 (`supabase_db_system-b-restore-main` on port 54332)
  - Remote Main Supabase (`yyiavtiwtekkocqpephr`)
- **Recorded In**: `supabase_migrations.schema_migrations`
- **DDL Changes**:
  ```sql
  -- Foreign Key Binding for auth.users
  ALTER TABLE public.agency_memberships
      ADD CONSTRAINT fk_agency_memberships_user_id
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

  CREATE INDEX IF NOT EXISTS idx_agency_memberships_user_id 
      ON public.agency_memberships(user_id);

  -- Domain Status Column & Lookup Index
  ALTER TABLE public.agency_domains 
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' 
      CHECK (status IN ('active', 'inactive', 'archived'));

  CREATE INDEX IF NOT EXISTS idx_agency_domains_hostname_status 
      ON public.agency_domains(hostname, status);

  -- Domain Resolution RPC
  CREATE OR REPLACE FUNCTION public.resolve_agency_domain(p_hostname TEXT)
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ ... $$;

  REVOKE EXECUTE ON FUNCTION public.resolve_agency_domain(TEXT) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.resolve_agency_domain(TEXT) TO anon, authenticated, service_role;
  ```

---

## 5. Verification Test Matrices

### 5.1 Unit & Integration Test Suite (`test/multi-agency-b2-b3.test.js`)
Executed with Node.js test runner in both `yeunauan-lms-clone` and `yeunauan-commerce-clone`:

| Test ID | Test Description | Result |
|---|---|:---:|
| **B3.1** | Host normalization cleans port, trailing dots, and lowercases | **PASS** |
| **B3.2** | Malformed host format fails closed | **PASS** |
| **B3.3** | Ambiguous forwarded host (comma-separated) fails closed (`AMBIGUOUS_FORWARDED_HOST = DENY`) | **PASS** |
| **B3.4** | Host precedence: `x-forwarded-host` precedes `host` when single valid value | **PASS** |
| **B3.5** | Header spoof guards ignore all untrusted tenant headers (`X_AGENCY_ID_SPOOF = NO EFFECT`) | **PASS** |
| **B3.6** | Tenant resolver fails closed on unknown or inactive host (`UNKNOWN_HOST = DENY`) | **PASS** |
| **B3.7** | Inactive agency / inactive domain fails closed (`INACTIVE_AGENCY = DENY, INACTIVE_DOMAIN = DENY`) | **PASS** |
| **B3.8** | Valid active host resolves immutable `TenantContext` (`VALID_ACTIVE_HOST = PASS`) | **PASS** |
| **B3.9** | Cache isolation prevents cross-tenant bleed (`HOST_CACHE_CROSS_TENANT_BLEED = DENY`) | **PASS** |
| **B2.1** | Authentication rejects missing session (`AUTH_NO_SESSION = DENY`) | **PASS** |
| **B2.2** | Rejects old legacy HMAC session token on new agency path (`OLD_HMAC_SESSION_ON_NEW_AGENCY_PATH = DENY`) | **PASS** |
| **B2.3** | Rejects expired or invalid Supabase JWT (`AUTH_EXPIRED_SESSION = DENY`) | **PASS** |
| **B2.4** | Valid Supabase JWT resolves stable user principal (`AUTH_VALID_USER = PASS`) | **PASS** |
| **B2.5** | Active membership in requested agency is allowed (`MEMBER_ACTIVE = ALLOW`) | **PASS** |
| **B2.6** | Suspended membership is denied (`MEMBER_SUSPENDED = DENY`) | **PASS** |
| **B2.7** | Membership in wrong agency is denied (`MEMBER_WRONG_AGENCY = DENY`) | **PASS** |
| **B2.8** | Role enforcement: student denied admin action, staff allowed, owner allowed | **PASS** |
| **B2.9** | Multi-agency user scope: user can have student role in Agency A and staff in Agency B | **PASS** |

**Unit Suite Summary**: 18 tests, 18 passed, 0 failed.

---

### 5.2 Real PostgREST Signed-JWT Exit Gate (`scripts/test-real-postgrest-jwt.js`)
Executed via live HTTPS fetch against Main Supabase (`https://yyiavtiwtekkocqpephr.supabase.co`):

| Scenario | Objective | Observed Result | Verdict |
|---|---|---|:---:|
| **Scenario 1** | Authenticated JWT with valid test user + matching membership calling `v5_authorize_agency_playback` | HTTP 200, `code: lesson_not_found` (Caller authentication and membership ownership verified) | **PASS** |
| **Scenario 2** | Authenticated JWT with another user's membership UUID | HTTP 200, `authorized: false, code: invalid_membership` (`Supplied membership ID does not match authenticated user membership`) | **PASS** |
| **Scenario 3** | Authenticated JWT attempting to access wrong agency | HTTP 200, `authorized: false, code: agency_membership_not_found` (`Caller has no membership in requested agency`) | **PASS** |
| **Scenario 4** | Expired or tampered JWT calling PostgREST endpoint | HTTP 401 Unauthorized (Rejected at PostgREST JWT boundary) | **PASS** |
| **Scenario 5** | Anonymous call without authenticated JWT | HTTP 401 Unauthorized, `permission denied for function v5_authorize_agency_playback` | **PASS** |
| **Scenario 6** | Authenticated JWT with spoofed headers (`x-user-id`, `x-agency-id`) | HTTP 200, `code: lesson_not_found` (Caller identity derived strictly from JWT `auth.uid()`, spoof ignored) | **PASS** |
| **Scenario 7** | `resolve_agency_domain` RPC resolution via PostgREST | HTTP 200, `found: true, agency_id: <uuid>` | **PASS** |

**PostgREST Gate Summary**: 7 scenarios, 7 passed, 0 failed.  
`POSTGREST_SIGNED_JWT_RPC_TEST = PASS`

---

### 5.3 Secret Pattern Scanning
Executed `scripts/scan-secrets.py` on all staged/modified files across both repositories:
- Patterns checked: JWT tokens, Supabase access tokens, Private keys, AWS keys, hardcoded passwords.
- Result: **PASS: No secret patterns detected.**

---

## 6. Architecture & Platform Safeguards

1. **V5 Media Architecture Preserved**:
   - Zero changes to V5 playback protocol, R2 buckets, Cloudflare Workers, cryptographic leases, ECDSA/P-256 signatures, or device proofs.
2. **Legacy Supabase Untouched**:
   - Legacy Supabase (`aqozjkfwzmyfunqvcyjv`) remained completely untouched and isolated.
3. **No Premature Milestones**:
   - B4 through B8 and M0C were not started.
   - Agency A production cutover was not started.

---

## 7. Handover Scorecard

```text
B2_GLOBAL_IDENTITY = PASS
B3_TENANT_RESOLVER = PASS
POSTGREST_SIGNED_JWT_RPC_TEST = PASS
TEST_COVERAGE_SUITE = PASS
GIT_BRANCH = feat/multi-agency-b2-b3
NEXT_STEP = WAIT_FOR_CHATGPT_WORK_B2_B3_REVIEW_GATE
```
