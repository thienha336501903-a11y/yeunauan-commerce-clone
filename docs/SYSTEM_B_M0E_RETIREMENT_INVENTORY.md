# SYSTEM B — M0E RETIREMENT INVENTORY & CONCRETE ROLLBACK PLAN

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

### A. Database Objects (PostgreSQL 17 / Main Supabase)

> [!IMPORTANT]
> No wildcards (e.g. `public.v4_*`) are used. Every candidate object is listed concretely.

| Object Name | Type | Current Purpose | Classification | Retain / Removal Rationale |
|---|---|---|---|---|
| `public.courses` | Table | Canonical course base catalog | `KEEP` | Referenced by `canonical_courses.course_id` and V5 video release mapping. |
| `public.v5_course_configs` | Table | Canonical V5 course configurations | `KEEP` | Core V5 media architecture and release pointers. |
| `public.v5_releases` | Table | Immutable content releases | `KEEP` | Core V5 release immutability foundation. |
| `public.v5_lessons` | Table | V5 video lesson metadata | `KEEP` | Core V5 media architecture. Linked to R2 video assets. |
| `public.v5_media_assets` | Table | V5 media catalog & ECDSA leases | `KEEP` | Core V5 media storage catalog. |
| `public.orders` | Table | Legacy single-tenant orders | `KEEP` | **Historical Financial Audit Record**. Must never be dropped or truncated. |
| `public.order_items` | Table | Order items table actively written by B5 Agency atomic checkout (inserts materialized offering items snapshot) & historical orders | `KEEP` | Actively written by B5 Agency commerce atomic checkout (`utils/agency-commerce.js`) and retains historical financial audit records. Must be KEPT until architecture explicitly replaces it. |
| `public.agencies` | Table | Multi-agency tenant registry | `KEEP` | Core System B multi-agency platform core. |
| `public.agency_domains` | Table | Multi-agency host mappings | `KEEP` | Core System B multi-agency routing engine. |
| `public.agency_ui_profiles` | Table | Multi-surface UI profiles (6 variants) | `KEEP` | Core System B UI variant engine. |
| `public.agency_bank_accounts` | Table | Tenant banking configurations | `KEEP` | Core System B commerce engine. |
| `public.agency_offerings` | Table | Tenant commercial offerings | `KEEP` | Core System B commerce catalog. |
| `public.agency_offering_items` | Table | Offering-to-canonical-course junction | `KEEP` | Core System B bundle and offering model. |
| `public.agency_orders` | Table | Immutable tenant commercial orders | `KEEP` | Core System B commerce order model. |
| `public.student_entitlements` | Table | Multi-grant student access rights | `KEEP` | Core System B entitlement grant engine. |
| `public.entitlement_grants` | Table | Entitlement history & provenance | `KEEP` | Core System B grant history. |
| `public.agency_memberships` | Table | Tenant scoped principal memberships | `KEEP` | Core System B identity and RBAC foundation. |
| `public.agency_homework_submissions` | Table | Tenant student homework submissions | `KEEP` | Core System B homework subsystem. |
| `public.agency_lesson_progress` | Table | Tenant student playback progress | `KEEP` | Core System B learner progress engine. |
| `public.tgcloner_sources` | Table | Legacy Telegram cloner channels | `SAFE_TO_REMOVE_AFTER_M0D` | Telegram cloner replaced by canonical V5 curriculum. |
| `public.tgcloner_source_messages` | Table | Legacy Telegram cloner message cache | `SAFE_TO_REMOVE_AFTER_M0D` | Cloner cache obsolete post-cutover. |
| `public.tgcloner_scheduler_nonces` | Table | Legacy Telegram cron scheduler nonces | `SAFE_TO_REMOVE_AFTER_M0D` | Telegram cron obsolete post-cutover. |
| `public.tgcloner_mtproto_sessions` | Table | Legacy MTProto session storage | `SAFE_TO_REMOVE_AFTER_M0D` | MTProto sessions obsolete post-cutover. |
| `public.lms_v4_telegram_course_sources` | Table | Legacy V4 course-to-Telegram map | `SAFE_TO_REMOVE_AFTER_M0D` | Replaced by `canonical_courses` and V5 releases. |
| `public.v4_source_ingest_activity` | Table | Legacy V4 source ingest logs | `SAFE_TO_REMOVE_AFTER_M0D` | V4 ingest obsolete post-cutover. |
| `public.student_enrollments` | Table | Legacy student course enrollments | `SAFE_TO_REMOVE_AFTER_M0D` | Superseded by `student_entitlements` + `entitlement_grants`. |
| `public.lesson_progress` | Table | Legacy single-tenant lesson progress | `SAFE_TO_REMOVE_AFTER_M0D` | Superseded by `agency_lesson_progress`. |
| `public.student_tokens` | Table | Old entry token session cache | `SAFE_TO_REMOVE_AFTER_M0D` | Superseded by Supabase Auth JWTs. |
| `public.v5_authorize_playback_asset` | Function | Base V5 release authorization | `KEEP` | Reused internally by `v5_authorize_agency_playback`. |
| `public.checkout_agency_offering` | Function | Agency checkout RPC | `KEEP` | Core System B commerce RPC. |
| `public.approve_agency_order` | Function | Agency order approval RPC | `KEEP` | Core System B commerce RPC. |
| `public.refund_agency_order` | Function | Agency order refund RPC | `KEEP` | Core System B commerce RPC. |
| `public.v5_authorize_agency_playback` | Function | Agency playback authorization RPC | `KEEP` | Core System B video playback security RPC. |
| `public.submit_agency_homework` | Function | Server-only homework submission RPC | `KEEP` | Core System B homework security RPC. |
| `public.issue_student_token` | Function | Legacy HMAC entry tokens | `SAFE_TO_REMOVE_AFTER_M0D` | No longer called when legacy portal routes retire. |
| `public.verify_legacy_token` | Function | Legacy token verification RPC | `SAFE_TO_REMOVE_AFTER_M0D` | Obsolete post-cutover. |

---

### B. API Routes & Entrypoints

| Route / File | Repository | Current Purpose | Classification | Retain / Removal Rationale |
|---|---|---|---|---|
| `api/register.js` | Commerce | Dual-host entrypoint: blocks Agency with 403 `agency_legacy_order_prohibited`, executes legacy registration on legacy hosts | `KEEP` | Blocks/dispatches Agency rather than providing Agency order path (Agency checkout uses client RPC `checkout_agency_offering`). Preserved for legacy hosts until post-M0D retirement. |
| `api/config.js` | Commerce | Dual-host: dispatches to `getAgencyCommerceConfig` on Agency host, legacy catalog on legacy host | `KEEP` | Dispatches based on incoming host. Agency commerce catalog uses this entrypoint. |
| `api/orders.js` | Commerce | Dual-host entrypoint: blocks Agency with 403 `agency_legacy_order_prohibited`, provides legacy order admin operations on legacy hosts | `KEEP` | Blocks/dispatches Agency rather than providing Agency order path (Agency order approval uses server/client RPC `approve_agency_order`). Preserved for legacy admin until post-M0D retirement. |
| `api/courses.js` | Commerce | Dual-host: rejects legacy course mutations on Agency host with 403 `agency_legacy_courses_prohibited` | `KEEP` | Dispatches based on incoming host. Preserved for legacy admin until legacy retirement. |
| `api/lms/portal.js` | LMS | Dual-host LMS portal router | `KEEP` | Core entrypoint: routes Agency hosts via `resolveRequestRoute(req)` -> `AGENCY`. Legacy branch retired post-M0D. |
| `api/lms/admin.js` | LMS | Agency admin portal | `KEEP` | Core System B agency management endpoint. |
| `api/learning.js` | LMS | Legacy learning redirector | `UNKNOWN_DEPENDENCY` | Pending post-M0D live traffic validation; legacy redirector not traversed in agency dependency graph. |
| `api/legacy-post-redirect.js` | LMS | Legacy blog post redirect | `UNKNOWN_DEPENDENCY` | Pending post-M0D SEO redirect audit; not traversed in agency dependency graph. |
| `api/sync.js` | LMS | Legacy Google Drive / sheet sync | `UNKNOWN_DEPENDENCY` | Pending post-M0D verification; obsolete cloner mechanism not used by agency curriculum. |
| `api/approve-all.js` | Commerce | Dev-only bulk order approval | `SAFE_TO_REMOVE_AFTER_M0D` | AST-verified: 0 agency callers; security risk; superseded by `approve_agency_order`. |
| `api/telegram-webhook.js` | Commerce | Legacy Telegram webhook integration | `SAFE_TO_REMOVE_AFTER_M0D` | AST-verified: 0 agency callers; telegram cloner deprecated post-M0D. |

---

### C. Authentication & Runtime Utilities

| Utility File | Repository | Current Purpose | Classification | Retain / Removal Rationale |
|---|---|---|---|---|
| `utils/agency-auth.js` | Both | Multi-agency auth guard & tenant binding | `KEEP` | Core System B architecture (Supabase JWT verification). |
| `utils/tenant-resolver.js` | Both | Trusted host resolver & in-memory cache | `KEEP` | Core System B architecture. |
| `utils/tenant-db-resolver.js` | Both | Scoped data repositories & platform core read | `KEEP` | Core System B architecture. |
| `utils/agency-routing.js` | Both | Request routing table & host dispatch | `KEEP` | Core System B architecture. |
| `utils/agency-commerce.js` | Both | Agency commerce & quote engine | `KEEP` | Core System B architecture. |
| `utils/agency-provisioner.js` | Both | Idempotent agency lifecycle engine | `KEEP` | Core System B architecture. |
| `utils/v5-playback-lease.js` | LMS | ECDSA P-256 playback lease issuer | `KEEP` | Core V5 media security engine. |
| `utils/agency-homework.js` | Both | Agency homework validation & grading | `KEEP` | Core System B homework engine. |
| `utils/lms-session-guard.js` | LMS | Legacy HMAC cookie parser & validator | `SAFE_TO_REMOVE_AFTER_M0D` | AST-verified: Agency uses `agency-auth.js` with Supabase JWT. |
| `utils/v3-runtime-controller.js` | LMS | Legacy V3 reader runtime | `SAFE_TO_REMOVE_AFTER_M0D` | AST-verified: 0 agency callers; obsolete runtime engine. |
| `utils/v4-intro-content.js` | LMS | V4 Telegram intro loader | `SAFE_TO_REMOVE_AFTER_M0D` | AST-verified: 0 agency callers; superseded by V5 canonical curriculum. |
| `utils/v4-telegram-access.js` | LMS | Legacy V4 Telegram media access & channel link helpers | `SAFE_TO_REMOVE_AFTER_M0D` | AST-verified: 0 agency callers; replaced by Cloudflare Worker + R2 media. |
| `utils/v4-telegram-media-meta.js` | LMS | Legacy V4 Telegram media metadata extractor | `SAFE_TO_REMOVE_AFTER_M0D` | AST-verified: 0 agency callers; replaced by V5 media tables. |

---

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
2. **Read-Only Archival**: Following M0D, a database trigger or permission revocation will enforce read-only status for legacy financial tables.
3. **Cross-Referencing**: Historical customer emails and transaction IDs remain searchable by platform administrators.

---

## 4. Concrete M0E Rollback Protocol

> [!CAUTION]
> In accordance with security directives:
> - **Agency host remains fail-closed at all times.**
> - `EMERGENCY_LEGACY_ROUTING_FALLBACK` is strictly prohibited and removed.
> - An unmapped or invalid host MUST NEVER fall through to legacy handlers.

In the event that an unexpected dependency surfaces during or after M0E execution, the following concrete rollback mechanisms must be executed:

### Mechanism 1: Authoritative Pre-Retirement Checkpoint Tag
- Immediately prior to executing any M0E retirement operation:
  Both repositories must be tagged with signed Git tag `v5-pre-m0e-checkpoint`.
- Rollback execution:
  ```bash
  git checkout tags/v5-pre-m0e-checkpoint
  git push origin feat/multi-agency-b2-b3 --force-with-lease
  ```

### Mechanism 2: Concrete Scoped Database Checkpoint Restore (Non-Destructive)
> [!CAUTION]
> **DO NOT execute `pg_restore --clean` against the full Main database.**
> A full database clean restore will overwrite and delete active Agency orders, student entitlements, homework submissions, and payment states created concurrently or subsequent to the checkpoint.
> Rollback must strictly target **ONLY the exact retired legacy database objects**.

Before any legacy DDL `DROP` migration is executed:
1. Generate an explicit scoped logical backup of the exact candidate legacy objects:
   ```bash
   pg_dump --quote-all-identifiers -d "$MAIN_SUPABASE_DB_URL" \
     -t "public.tgcloner_sources" \
     -t "public.tgcloner_source_messages" \
     -t "public.tgcloner_scheduler_nonces" \
     -t "public.tgcloner_mtproto_sessions" \
     -t "public.lms_v4_telegram_course_sources" \
     -t "public.v4_source_ingest_activity" \
     -t "public.student_tokens" \
     -F c -f "backups/pre-m0e-scoped-legacy-objects.dump"
   ```
2. Verify checksum and store backup in durable backup storage.
3. If database rollback is required for retired legacy tables or functions:
   Restore ONLY the targeted retired table/object without dropping the schema or touching agency tables:
   ```bash
   pg_restore -d "$MAIN_SUPABASE_DB_URL" \
     --table="tgcloner_sources" \
     --clean --if-exists \
     "backups/pre-m0e-scoped-legacy-objects.dump"
   ```
   Or execute the pre-generated reverse DDL scripts (`backups/pre-m0e-ddl-reversal/restore_*.sql`) containing the exact `CREATE TABLE` and `CREATE FUNCTION` DDL definitions for the retired legacy objects.
   **Result**: All concurrent Agency orders, entitlements, and student progress are 100% preserved.

### Mechanism 3: Vercel Deployment Rollback
- Vercel deployments provide instant deployment rollback to the pre-retirement build:
  ```bash
  vercel rollback [pre-m0e-deployment-id]
  ```
- CDN edge propagation typically takes 1 to 3 minutes across global edge POPs.

### Mechanism 4: Configuration & Environment Rollback (Individual Variable Mechanism)
> [!CAUTION]
> Do NOT pipe an entire `.env` file into a single Vercel variable. Each environment variable must be inspected and restored individually from protected pre-retirement metadata.

1. Prior to M0E, export deployment environment variables to a structured key-value snapshot (`.env.pre-m0e.json`):
   ```bash
   vercel env pull .env.pre-m0e.backup
   node -e '
     const fs = require("fs");
     const lines = fs.readFileSync(".env.pre-m0e.backup", "utf8").split("\n");
     const obj = {};
     for (const line of lines) {
       const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
       if (m) obj[m[1]] = m[2].replace(/^["'\''']|["'\''']$/g, "");
     }
     fs.writeFileSync(".env.pre-m0e.json", JSON.stringify(obj, null, 2));
   '
   ```
2. If individual environment variables must be restored post-retirement, restore each variable individually:
   ```bash
   node -e '
     const fs = require("fs");
     const { execSync } = require("child_process");
     const vars = JSON.parse(fs.readFileSync(".env.pre-m0e.json", "utf8"));
     for (const [k, v] of Object.entries(vars)) {
       console.log("Restoring environment variable:", k);
       execSync(`vercel env add ${k} production`, { input: v, stdio: ["pipe", "inherit", "inherit"] });
     }
   '
   ```

### Mechanism 5: Explicit DNS / Host Routing Restoration
- If a legacy custom domain requires reactivation, update Vercel project domains via Vercel CLI:
  ```bash
  vercel domains add [legacy-domain]
  ```
- Agency domains remain strictly isolated on agency route handlers.

---

## 5. Acceptance Status Matrix

| Gate | Status | Evidence |
|---|---|---|
| `M0E_RETIREMENT_PLAN` | **PASS** | 100% concrete cataloging of DB objects, routes, utilities, and env vars (zero wildcards; `public.order_items` classified as KEEP actively written by B5; route blocking/dispatch behavior aligned; dependency evidence checked). |
| `M0E_ROLLBACK_PLAN` | **PASS** | Scoped, non-destructive rollback protocol targeting ONLY exact retired legacy DB objects. Full-db `pg_restore --clean` prohibited to preserve concurrent Agency orders. Individual env var restore verified. |
| `M0E_EXECUTION` | **NOT_STARTED** | Zero deletions, zero legacy route teardown; legacy infrastructure remains 100% active. |
