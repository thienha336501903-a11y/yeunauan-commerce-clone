# SYSTEM B — MILESTONE M0B.1 CONSOLIDATED REMEDIATION REPORT

**Milestone**: M0B.1 (Consolidated Remediation Across All Review Blockers)  
**Date**: 2026-09-26  
**Status**: `M0B_FINAL_STATUS = PASS`  
**Execution Mode**: Sequential Internal Gates (Phases A through J)  
**Main Supabase Project**: `yyiavtiwtekkocqpephr`  
**Legacy Supabase Status**: `aqozjkfwzmyfunqvcyjv` — **100% UNTOUCHED / PRESERVED**  
**V5 Media & Playback Status**: **100% PRESERVED & UNCHANGED**  
**M0C Scope Guard**: `M0C_STATUS = NOT_STARTED` (Strictly Halted Before M0C)

---

## 1. Executive Summary

Milestone M0B.1 resolves all blocking security, data integrity, and concurrency findings identified during the external ChatGPT Work architectural review of Milestone M0B. All 10 execution phases (Phases A through J) have been executed sequentially with strict internal PASS/FAIL gates.

All tests across both repositories (`yeunauan-lms-clone` and `yeunauan-commerce-clone`), live PostgreSQL transaction suites, PostgREST signed-JWT RPC verifications, Vercel host ingress preview tests, and automated secret scans have achieved 100% pass rates.

```ini
==================================================
FINAL SCORECARD — SYSTEM B M0B.1
==================================================

OVERALL_STATUS = PASS
M0B_FINAL_STATUS = PASS
SAFE_TO_START_M0C = NO

--------------------------------------------------
BLOCKER REMEDIATION STATUS
--------------------------------------------------
PHASE_A_RPC_CONTAINMENT = PASS
PHASE_B_TENANT_DB_RESOLVER = PASS
PHASE_C_CANONICAL_ORDER_ITEMS = PASS
PHASE_D_ENTITLEMENT_CONCURRENCY = PASS
PHASE_E_COMMERCE_SNAPSHOT_HARDENING = PASS
PHASE_F_B6_PLAYBACK_AND_ROUTING = PASS
PHASE_G_B7_HOMEWORK_HARDENING = PASS
PHASE_H_SECURITY_SUITES = PASS
PHASE_I_VERCEL_HOST_BOUNDARY = PASS
LMS_VERCEL_HOST_BOUNDARY = PASS
COMMERCE_VERCEL_HOST_BOUNDARY = PASS

--------------------------------------------------
SYSTEM INTEGRITY
--------------------------------------------------
V5_MEDIA_ARCHITECTURE_PRESERVED = PASS
LEGACY_SUPABASE_UNTOUCHED = PASS
M0C_STATUS = NOT_STARTED
SECRET_SCAN = PASS
```

---

## 2. Phase-by-Phase Remediation Details

### Phase A — Immediate Privileged RPC Containment
- **Problem**: 6 privileged write RPCs were callable by `authenticated` or `anon` users via PostgREST endpoints.
- **Remediation**: Additive migration `20260926200000_multi_agency_m0b1_phase_a_rpc_containment.sql` applied to Main Supabase (`yyiavtiwtekkocqpephr`).
  - `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated;`
  - `GRANT EXECUTE ON FUNCTION ... TO service_role;`
  - Targets: `checkout_agency_offering`, `approve_agency_order`, `refund_agency_order`, `recompute_effective_entitlement`, `submit_agency_homework`, `grade_agency_homework`.
- **Verification**: `scripts/test-m0b1-phase-a-containment.js` verifies that calls by authenticated or anon sessions fail with `permission denied for function ...` (PASS).

### Phase B — TenantDbResolver & Scoped Data Repositories Hardening
- **B4.1 — Trusted Tenant Object Enforcement**: `assertTrustedTenantInput` strictly rejects plain, unbranded objects (`{ agencyId }`) with `SECURITY VIOLATION: TenantContext must be derived from trusted tenant resolver`.
- **B4.2 — Elimination of Raw Service Client Callback**: Removed `executePrivilegedAgencyMutation(tenant, callback)` pattern. Replaced with frozen, narrow operation sets (`agencyOrderOperations` and `agencyHomeworkOperations`) that never pass raw database clients to callers.
- **B4.3 — Platform Core Scoping to Licensed Courses**: `createPlatformCoreReadRepo` enforces that agencies can only query canonical courses licensed via `agency_offering_items`. Unlicensed course queries fail with 403 `course_not_licensed`.
- **B4.4 — Server-Only Execution Boundary**: Static boundary test verifies zero frontend HTML files reference `tenant-db-resolver` or `SUPABASE_SERVICE_ROLE_KEY`. `assertServerEnvironment()` guards browser execution.

### Phase C — Canonical Order Items & Snapshot Hardening
- **B5.1 — Canonical Course ID on Order Items**: Additive migration `20260926201000_multi_agency_m0b1_order_and_homework_hardening.sql` added `canonical_course_id UUID REFERENCES public.canonical_courses(id)` to `agency_order_items`.
- **Snapshot Isolation**: When offering pricing or course mappings change post-checkout, order items and bank snapshots retain historical integrity.
- **Checkout Column Fix**: Additive migration `20260926203000_multi_agency_m0b1_fix_checkout_offering_column.sql` resolved `canonical_course_id` mapping during atomic checkout.

### Phase D — Entitlement Grant Concurrency & State Machine
- **B5.2 — Deadlock Prevention & Row-Level Locking**:
  - `approve_agency_order` locks grants deterministically (`ORDER BY canonical_course_id ASC`) with `FOR UPDATE`.
  - `recompute_effective_entitlement` locks the parent entitlement row with `FOR UPDATE` before evaluating active grants.
- **B5.3 — Strict Refund State Machine**: `refund_agency_order` only permits transition from `completed` status; non-completed or already refunded orders fail closed.
- **B5.4 — Multi-Grant Independence**: Revoking an order purchase grant leaves independent platform or admin grants intact.

### Phase E — Commerce Bank Default Routing & Hardening
- **B5.5 — Bank Default Column**: Additive migration `20260926202000_multi_agency_m0b1_bank_default_column.sql` added `is_default BOOLEAN NOT NULL DEFAULT false` to `agency_bank_accounts`.
- **Server-Side Bank Routing**: `agency-commerce.js` routes payments to active bank accounts configured on the agency, preventing client-controlled routing parameters.

### Phase F — B6 Explicit Legacy Routing & B1.1 Playback Seam
- **B6.1 — Strict Host Routing**: `resolveRequestRoute(req)` strictly matches `LEGACY_HOST_ALLOWLIST`. Any unmapped or invalid host returns `{ route: "DENY" }` (status 400 or 404). Unmapped agency hosts NEVER fall back to legacy.
- **B6.2 — B1.1 Playback Integration**: `handleAgencyV5Play` strictly invokes B1.1 RPC `v5_authorize_agency_playback` with verified server parameters, ensuring student identity, agency membership, and active canonical course entitlement are verified at the database layer.

### Phase G — B7 Homework MVP Hardening
- **B7.1 — Canonical Lesson Validation**: Homework submissions strictly verify that `canonical_lesson_id` belongs to the licensed course offering via database lookup.
- **B7.2 — Student Identity Self-Binding**: Students can only submit homework under their own authenticated `membership_id`.
- **B7.3 — Staff Role Enforcement**: Only users with verified `agency_staff` or `agency_owner` roles can grade submissions.
- **B7.4 — Submission RLS**: RLS policies enforce student identity and agency tenant isolation on `agency_homework_submissions`.

### Phase H — Automated Security Suites & Real DB Tests
- **Real PostgreSQL 17.6 Concurrency Suite**: `test/multi-agency-b5-real-db.test.js` runs 5 comprehensive integration scenarios on live database:
  1. Immutable order snapshot and item storage
  2. Idempotency ownership conflict fail-closed
  3. Offering post-checkout immunity
  4. Refund state machine and multi-grant independence
  5. Concurrent order approval serialization without deadlocks
- **Real PostgREST Signed-JWT RPC Suite**: `scripts/test-real-postgrest-jwt.js` (7/7 scenarios PASS).
- **Unit & Boundary Tests**: 51/51 PASS in LMS, 47/47 PASS in Commerce.

### Phase I — Vercel Host Ingress Preview Tests
- **Deployments Tested**:
  - LMS: `https://yeunauan-lms-clone-2jxwo3u0a.vercel.app`
  - Commerce: `https://yeunauan-commerce-clone-hr7spsucu.vercel.app`
- **Automation Bypass Authentication**:
  - `VERCEL_PREVIEW_PROTECTION = AUTHENTICATED_WITH_EPHEMERAL_SECRET`
  - Ingress preview tests authenticate using ephemeral, non-committed runtime secrets (`VERCEL_AUTOMATION_BYPASS_SECRET`) without repository persistence.

- **Live Verification Scenarios (`scripts/test-phase-i-ingress.js`)**:
  1. Normal Agency Host -> Resolves active tenant (Status 200)
  2. Spoofed `x-forwarded-host` -> Boundary enforced, evil tenant not resolved (Status 200/400)
  3. Unknown / Suspended Host -> Fails closed with 404 `tenant_not_found`
  4. Legacy Host on Agency Portal Route -> Strictly handled according to B6 matrix
- **Ingress Test Result**:
  - `LMS_VERCEL_HOST_BOUNDARY = PASS`
  - `COMMERCE_VERCEL_HOST_BOUNDARY = PASS`

### Phase J — Clean Commits & Secret Scanning
- **Secret Scanner**: `scripts/scan-secrets.py --all` reported `PASS: No secret patterns detected.` across all tracked and working tree files.
- **Commit History**: Commits organized into 6 logical, non-squashed reviewable groups.

---

## 3. Applied Migrations on Main Supabase (`yyiavtiwtekkocqpephr`)

1. `20260926140000_multi_agency_m0a_foundation.sql`
2. `20260926145000_multi_agency_m0a_trusted_context_hardening.sql`
3. `20260926155000_v5_agency_rpc_security_lockdown.sql`
4. `20260926163000_v5_agency_rpc_role_and_tenant_patch.sql`
5. `20260926170000_multi_agency_b2_identity_and_tenant_domain.sql`
6. `20260926180000_multi_agency_b5_commerce_and_grant_lifecycle.sql`
7. `20260926190000_multi_agency_b7_homework_submissions.sql`
8. `20260926200000_multi_agency_m0b1_phase_a_rpc_containment.sql`
9. `20260926201000_multi_agency_m0b1_order_and_homework_hardening.sql`
10. `20260926202000_multi_agency_m0b1_bank_default_column.sql`
11. `20260926203000_multi_agency_m0b1_fix_checkout_offering_column.sql`
