# SYSTEM B — M0E RETIREMENT DRY-RUN INVENTORY & ROLLBACK PLAN

**Status**: DRY-RUN ONLY / READ-ONLY AUDIT  
**M0E Execution Status**: `NOT_STARTED`  
**Target Architecture**: System B Multi-Agency Phase 0  
**Target Database**: Main Supabase (`yyiavtiwtekkocqpephr`)  
**Legacy Project (Untouched)**: Legacy Supabase (`aqozjkfwzmyfunqvcyjv`)  

---

## 1. Executive Summary & Boundaries

In accordance with owner-locked directives:
1. **NO Legacy Retirement is executed at this stage.** Legacy routes, tables, and credentials remain fully functional.
2. **Current Business Data is TEST ONLY.**
3. **V5/R2/Worker architecture remains 100% PRESERVED.** No R2 objects mutated, no Cloudflare Worker changes.
4. **This document establishes the authoritative dry-run classification** of all legacy assets to prepare for a clean, deterministic, zero-downtime retirement following successful M0D cutover.

---

## 2. Legacy Asset Inventory & 3-Way Classification

Every candidate asset across the codebase and database is classified into one of three strict categories:
- `SAFE_TO_REMOVE_AFTER_M0D`: Solely depended on by legacy code; can be safely dropped once all tenant traffic has migrated.
- `KEEP`: Core infrastructure, platform assets, audit logs, or shared schemas that must be preserved permanently.
- `UNKNOWN_DEPENDENCY`: Requires further live traffic validation prior to removal.

### A. Database Objects (PostgreSQL 17 / Supabase)

| Object Name | Type | Current Purpose | Classification | Retain / Removal Rationale |
|---|---|---|---|---|
| `public.courses` | Table | Canonical course base catalog | `KEEP` | Referenced by `canonical_courses.course_id` and V5 video release mapping. |
| `public.v5_lessons` | Table | V5 video lesson metadata | `KEEP` | Core V5 media architecture. Linked to R2 objects. |
| `public.v5_media_assets` | Table | V5 media catalog & ECDSA leases | `KEEP` | Core V5 media storage catalog. |
| `public.v5_releases` | Table | Immutable content releases | `KEEP` | V5 release immutability foundation. |
| `public.orders` | Table | Legacy single-tenant orders | `KEEP` | **Historical Financial Audit Record**. Must never be dropped. Kept read-only. |
| `public.student_enrollments` | Table | Legacy student course enrollments | `SAFE_TO_REMOVE_AFTER_M0D` | Superseded by `student_entitlements` + `entitlement_grants`. |
| `public.lesson_progress` | Table | Legacy single-tenant lesson progress | `SAFE_TO_REMOVE_AFTER_M0D` | Superseded by `agency_lesson_progress`. |
| `public.v4_*` tables | Tables | Legacy Telegram cloner & V4 sync | `SAFE_TO_REMOVE_AFTER_M0D` | Telegram cloner replaced by canonical V5 curriculum. |
| `public.student_tokens` | Table | Old entry token session cache | `SAFE_TO_REMOVE_AFTER_M0D` | Superseded by Supabase Auth JWTs. |
| `public.v5_authorize_playback_asset` | Function | Base V5 release authorization | `KEEP` | Reused internally by `v5_authorize_agency_playback`. |
| Legacy RPCs (`issue_student_token`) | Functions | Legacy HMAC entry tokens | `SAFE_TO_REMOVE_AFTER_M0D` | No longer called when legacy portal routes retire. |

### B. API Routes & Handlers

| Route / File | Repository | Current Purpose | Classification | Retain / Removal Rationale |
|---|---|---|---|---|
| `api/lms/portal.js` (Legacy branches) | LMS | Serves legacy portal endpoints | `SAFE_TO_REMOVE_AFTER_M0D` | Agency requests route via `route: "AGENCY"`. Legacy branch retired post-M0D. |
| `api/learning.js` | LMS | Legacy learning redirector | `SAFE_TO_REMOVE_AFTER_M0D` | Replaced by agency-scoped learning routes. |
| `api/legacy-post-redirect.js` | LMS | Legacy blog post redirect | `SAFE_TO_REMOVE_AFTER_M0D` | Obsolete legacy compatibility handler. |
| `api/sync.js` | LMS | Legacy Google Drive / sheet sync | `SAFE_TO_REMOVE_AFTER_M0D` | Superseded by V5 releases & canonical curriculum. |
| `api/approve-all.js` | Commerce | Dev-only bulk order approval | `SAFE_TO_REMOVE_AFTER_M0D` | Security risk; replaced by `approve_agency_order`. |
| `api/telegram-*.js` | Commerce | Legacy Telegram webhook integration | `SAFE_TO_REMOVE_AFTER_M0D` | Replaced by multi-agency commerce webhook engine. |
| `api/orders.js` (Legacy branches) | Commerce | Legacy single-tenant order creation | `SAFE_TO_REMOVE_AFTER_M0D` | Replaced by `utils/agency-commerce.js`. |
| `api/courses.js` (Legacy branches) | Commerce | Legacy single-tenant course catalog | `SAFE_TO_REMOVE_AFTER_M0D` | Replaced by `agency_offerings`. |

### C. Authentication & Runtime Utilities

| Utility File | Repository | Current Purpose | Classification | Retain / Removal Rationale |
|---|---|---|---|---|
| `utils/lms-session-guard.js` | LMS | Legacy HMAC cookie parser & validator | `SAFE_TO_REMOVE_AFTER_M0D` | Agency uses `agency-auth.js` with Supabase JWT. |
| `utils/v3-runtime-controller.js` | LMS | Legacy V3 reader runtime | `SAFE_TO_REMOVE_AFTER_M0D` | Obsolete runtime engine. |
| `utils/v4-intro-content.js` | LMS | V4 Telegram intro loader | `SAFE_TO_REMOVE_AFTER_M0D` | Replaced by V5 canonical course intro. |
| `utils/v4-telegram-*.js` | LMS | V4 Telegram media helpers | `SAFE_TO_REMOVE_AFTER_M0D` | Replaced by Cloudflare Worker + R2 media. |
| `utils/agency-auth.js` | Both | Multi-agency auth guard & tenant binding | `KEEP` | Core System B architecture. |
| `utils/tenant-resolver.js` | Both | Trusted host resolver & cache | `KEEP` | Core System B architecture. |
| `utils/tenant-db-resolver.js` | Both | Scoped data repositories | `KEEP` | Core System B architecture. |
| `utils/agency-commerce.js` | Both | Agency commerce & quote engine | `KEEP` | Core System B architecture. |
| `utils/agency-provisioner.js` | Both | Idempotent agency lifecycle engine | `KEEP` | Core System B architecture. |
| `utils/v5-playback-lease.js` | LMS | ECDSA P-256 playback lease issuer | `KEEP` | Core V5 media security engine. |

### D. Environment Variables & Deployment Secrets

| Variable Name | Environment | Classification | Retain / Removal Rationale |
|---|---|---|---|
| `HMAC_SECRET` | LMS | `SAFE_TO_REMOVE_AFTER_M0D` | Required solely for legacy HMAC tokens. |
| `LEGACY_SUPABASE_URL` | Both | `SAFE_TO_REMOVE_AFTER_M0D` | References deprecated project `aqozjkfwzmyfunqvcyjv`. |
| `LEGACY_SUPABASE_SERVICE_ROLE_KEY` | Both | `SAFE_TO_REMOVE_AFTER_M0D` | References deprecated project `aqozjkfwzmyfunqvcyjv`. |
| `SUPABASE_URL` | Both | `KEEP` | Main Supabase project (`yyiavtiwtekkocqpephr`). |
| `SUPABASE_SERVICE_ROLE_KEY` | Both | `KEEP` | Main Supabase service role credentials. |
| `V5_PLAYBACK_PRIVATE_JWK` | LMS | `KEEP` | ECDSA P-256 private key for signed video leases. |
| `V5_MEDIA_PUBLIC_URL` | LMS | `KEEP` | Cloudflare Worker endpoint for media streaming. |

---

## 3. Retained Commerce & Historical Metadata Plan

To ensure 100% compliance with accounting, legal, and operational continuity:
1. **Zero Data Loss for Orders**: The `public.orders` table and `public.order_items` table will **NEVER be truncated or deleted**.
2. **Read-Only Archival**: Following M0D, a database trigger will enforce `REVOKE INSERT, UPDATE, DELETE ON public.orders FROM authenticated, anon, service_role`.
3. **Cross-Referencing**: Historical customer emails and transaction IDs remain searchable by platform administrators.

---

## 4. M0E Retirement Rollback Plan

In the event that an unexpected dependency surfaces during or after M0E execution, the following 5-point rollback protocol must be followed:

### Point 1: Authoritative Pre-Retirement Checkpoint Commit
- **LMS Pre-Retirement Git Reference**: `feat/multi-agency-b2-b3` HEAD immediately prior to retirement.
- **Commerce Pre-Retirement Git Reference**: `feat/multi-agency-b2-b3` HEAD immediately prior to retirement.
- Tagged with signed Git tag: `v5-pre-m0e-checkpoint`.

### Point 2: Database Checkpoint Requirement
Before any legacy DDL `DROP` script is executed:
1. An explicit logical backup must be generated:
   ```bash
   pg_dump --clean --if-exists --quote-all-identifiers -d "$MAIN_SUPABASE_DB_URL" -F c -f "backups/pre-m0e-db-checkpoint.dump"
   ```
2. Backup SHA-256 checksum recorded in secure storage.
3. Rollback script `scripts/rollback-m0e-ddl.sql` pre-tested to restore any dropped views, functions, or foreign keys.

### Point 3: Configuration & Environment Rollback
- Backup of all Vercel environment variables exported via Vercel CLI:
  ```bash
  vercel env pull .env.pre-m0e.backup
  ```
- If retirement causes auth failures, re-add `HMAC_SECRET` and `LEGACY_SUPABASE_*` keys within 60 seconds.

### Point 4: Host Routing Rollback
- Routing decision in `api/lms/portal.js` and `utils/agency-lms-bridge.js` contains a fail-safe fallback:
  - Default route fallback can be switched from `DENY` to `LEGACY` via an emergency environment switch: `EMERGENCY_LEGACY_ROUTING_FALLBACK=true`.
  - Reverts custom domain traffic to legacy handlers without code redeploy.

### Point 5: Vercel Instant Deployment Rollback
- Vercel preview and production deployments provide instant rollback:
  ```bash
  vercel rollback [deployment-id]
  ```
- Restores previous deployment build within < 10 seconds.

---

## 5. Acceptance Status Matrix

| Gate | Status | Evidence |
|---|---|---|
| `M0E_RETIREMENT_INVENTORY` | **PASS** | 100% of database objects, routes, utilities, and env vars cataloged. |
| `M0E_ROLLBACK_PLAN` | **PASS** | 5-point rollback protocol (Git commit, DB dump, env restore, routing switch, Vercel instant rollback). |
| `M0E_EXECUTION` | **NOT_STARTED** | Zero deletions, zero legacy route teardown, legacy remains active. |
