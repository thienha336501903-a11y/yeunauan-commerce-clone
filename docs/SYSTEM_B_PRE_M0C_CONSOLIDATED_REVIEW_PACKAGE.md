# SYSTEM B — PRE-M0C / PRE-M0D / PRE-M0E CONSOLIDATED REVIEW PACKAGE

**Authoritative Plan**: `SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md`  
**Evaluation Mode**: IMPLEMENTATION + REHEARSAL + READ-ONLY AUDIT  
**Review Target**: ChatGPT Work Consolidated Pre-Execution Review  
**Date**: September 26, 2026  

---

## 1. M0B.1 Final Code & Security State

All findings from the M0B review have been fully addressed and hardened:
1. **RPC Containment (Phase A)**: 
   - 6 sensitive financial, grant, and grading RPCs (`checkout_agency_offering`, `approve_agency_order`, `refund_agency_order`, `recompute_effective_entitlement`, `submit_agency_homework`, `grade_agency_homework`) have had privileges strictly revoked from `PUBLIC`, `anon`, and `authenticated`.
   - Verified fail-closed: Authenticated PostgREST calls receive `403 permission denied`. Only trusted backend server callers with `service_role` can execute these operations.
2. **Deterministic Locking & Concurrency (Phase B)**:
   - Entitlement parent rows (`student_entitlements`) are explicitly locked with `FOR UPDATE` prior to inserting grants or recalculating effective status.
   - Concurrent approval transactions serialize cleanly without deadlock.
3. **Immutable Financial Snapshots (Phase C)**:
   - Order price and bank details are derived authoritatively on the server and snapshotted immutably into `agency_orders` at checkout time.
   - Subsequent changes to catalog prices or bank accounts do not alter active orders.
   - Idempotent retries return the stored immutable snapshot rather than recalculating today's price.
4. **Multi-Source Entitlement Independence (Phase D)**:
   - Multiple grants (`order_purchase`, `manual_admin`, `bundle_package`, etc.) coexist independently under the parent entitlement.
   - Revoking an order purchase grant does not destroy coexisting admin or promotional grants.
5. **Fail-Closed Host Ingress & Inactive Domain Gate (Phase I)**:
   - Unknown domains, malformed authority headers, conflicting forwarded hosts, and inactive domains fail closed with strict 404/403 responses and zero fallback to legacy.

---

## 2. Security Incident Containment State

1. **Credential Invalidation & Rotation**:
   - Both compromised Vercel Preview Deployment Protection bypass credentials (LMS: `prj_0mFDJL5lV9q0NBjgBphs0Y6j1Xtc`, Commerce: `prj_9LIdNafm4JYpYCNA6ujbIlQs2Bh9`) were immediately revoked and regenerated via Vercel REST API (`PATCH /v1/projects/:id/protection-bypass`).
   - Old credentials verified permanently dead (302 redirect to Vercel SSO login).
2. **Git History & Working Tree Purge**:
   - Plaintext credentials and intermediate leaked commits were purged from git history.
   - Clean branches force-pushed with sanitized commit logs.
3. **Hardened Secret Scanner**:
   - Multi-layer scanner `scripts/scan-secrets.py` enforces regex scanning for private keys, JWTs, Vercel tokens, service keys, and generic credential patterns across tracked files, unstaged diffs, and git commits.
   - Verification status: `SECRET_SCAN = PASS`.

---

## 3. M0C Provisioning Tooling

1. **Idempotent Provisioning Engine (`utils/agency-provisioner.js`)**:
   - **`planAgencyProvisioning(manifest)`**: Performs a dry-run comparison between the manifest and current database state, returning deterministic counts of `creates`, `updates`, `unchanged`, and `conflicts`.
   - **`applyAgencyProvisioning(manifest)`**: Executes provisioning idempotently. Safe to run repeatedly; creates zero duplicates and never overwrites another tenant.
   - **`deprovisionAgency(slug)`**: Safely rolls back and purges tenant records in strict foreign-key order. Protected agency slugs (`yeunauan`, `agency-a`) are barred from deprovisioning unless synthetic flags are set.
2. **Fail-Closed 11-Point Validator (`validateAgencyProvisioning`)**:
   - Verifies: `AGENCY_EXISTS`, `DOMAINS_VALID`, `DOMAIN_COLLISION_FREE`, `UI_PROFILE_COMPLETE`, `BANK_CONFIG_COMPLETE`, `OFFERINGS_COMPLETE`, `COURSE_MAPPING_COMPLETE`, `V5_MAPPING_COMPLETE`, `PRINCIPALS_COMPLETE`, `MEMBERSHIPS_COMPLETE`, `HOMEWORK_READY`.
3. **CLI Tool (`scripts/provision-agency.js`)**:
   - Provides operators with `plan`, `apply`, `validate`, and `deprovision` modes. Credential-free and fail-closed.

---

## 4. Synthetic Agency A Rehearsal

A complete end-to-end rehearsal was conducted using disposable synthetic fixtures (`syn-agency-*`) in both LMS and Commerce (`test/synthetic-agency-provisioning.test.js`):
1. **Empty Tenant Provisioning**: Successfully planned and applied from an empty tenant state.
2. **Idempotency Rehearsal**: Second plan reported `creates = 0`, second apply produced 0 duplicates.
3. **Readiness Validation**: All 11 readiness gates evaluated to `true`.
4. **Commerce Lifecycle Rehearsal**:
   - Verified checkout -> immutable order snapshot (price, bank, transfer code).
   - Duplicate checkout returned identical stored snapshot (`idempotent: true`).
   - Price changed in catalog after checkout -> order snapshot price remained unchanged.
   - Bank changed after checkout -> order snapshot bank remained original.
   - Order approval transitioned status to `completed` and created active student entitlement.
   - Multi-grant co-existence verified by adding independent `manual_admin` grant.
5. **LMS Playback Authorization Rehearsal**:
   - B1.1 agency playback authorization RPC verified:
     - Cross-tenant or unentitled callers are strictly denied (`invalid_membership`, `cross_agency_forbidden`).
     - Entitled students proceed to canonical curriculum resolution.
   - Status: `SYNTHETIC_AGENCY_AUTHORIZATION = PASS`.
   - Real positive playback remains deferred: `REAL_AGENCY_A_PLAYBACK = NOT_EXECUTED`.
6. **Deprovisioning Teardown**: Deprovisioning deleted 100% of tenant records in correct FK order.

---

## 5. M0D No-Legacy Readiness

1. **Deterministic Legacy Dependency Matrix (`utils/m0d-dependency-checker.js`)**:
   - Audited all 7 new Agency functional paths: `storefront`, `checkout`, `agency admin`, `learner`, `learning`, `homework`, `V5 playback`.
   - Result:
     - `LEGACY_REQUIRED`: `NO` for 7/7 paths.
     - `LEGACY_REFERENCE_FOUND`: `NO` for 7/7 paths.
     - `BLOCKING_REFERENCE`: `NONE` across all paths.
2. **Pre-Cutover Operational Gates**:
   - Agency host routes never fall to Legacy: `PASS`.
   - Authenticated Agency users never use old HMAC: `PASS`.
   - Commerce uses `agency_*` tables exclusively: `PASS`.
   - Entitlements use multi-grant model: `PASS`.
   - Playback uses B1.1 agency authorization: `PASS`.
   - Progress uses `agency_lesson_progress`: `PASS`.
   - Homework uses `agency_homework_submissions`: `PASS`.
   - No Agency requests require Legacy DB: `PASS`.
3. **Execution Status**:
   - `M0D_READINESS_TOOLING = PASS`
   - `M0D_EXECUTION = NOT_STARTED` (Zero legacy deletion/disabling).

---

## 6. M0E Retirement Dry-Run Inventory & Rollback Plan

1. **Retirement Inventory (`docs/SYSTEM_B_M0E_RETIREMENT_INVENTORY.md`)**:
   - Full 3-way classification (`SAFE_TO_REMOVE_AFTER_M0D`, `KEEP`, `UNKNOWN_DEPENDENCY`) of all database tables, views, RPCs, routes, session guards, and environment variables.
   - Invariant: `public.orders` and historical financial metadata are classified as `KEEP` and preserved permanently.
2. **5-Point Rollback Protocol**:
   - Checkpoint commit reference tagged with signed tag.
   - Database logical backup checkpoint (`pg_dump`) prior to any DDL drop.
   - Vercel environment variable backup and rapid restore.
   - Emergency routing fallback switch (`EMERGENCY_LEGACY_ROUTING_FALLBACK=true`).
   - Vercel instant deployment rollback (< 10 seconds).
3. **Execution Status**:
   - `M0E_RETIREMENT_INVENTORY = PASS`
   - `M0E_ROLLBACK_PLAN = PASS`
   - `M0E_EXECUTION = NOT_STARTED`

---

## 7. Generic Future-Agency Tooling Proof

1. **Manifest Template (`templates/generic-agency-manifest.template.json`)**:
   - Parameterized manifest template supporting Agency B, Agency C, or arbitrary future agencies without code changes.
   - Zero hard-coded Agency A IDs or domains.
2. **Second-Tenant Isolation Test (`test/second-tenant-isolation.test.js`)**:
   - Concurrently provisioned Tenant Alpha and Tenant Beta.
   - Verified domain collision prevention: Tenant Beta rejected when attempting to claim Tenant Alpha's domain.
   - Verified cross-tenant membership isolation: Alpha member denied checkout in Beta agency.
   - Verified cross-tenant playback denial: Alpha member denied playback in Beta agency with explicit `cross_agency_forbidden` error.
   - Clean teardown of both tenants verified.
   - Status: `GENERIC_AGENCY_PROVISIONING = PASS`, `SECOND_TENANT_ISOLATION_TEST = PASS`.

---

## 8. Tests and Evidence Summary

| Test Suite / Tool | LMS Result | Commerce Result | Status |
|---|---|---|---|
| B2/B3 Host Resolution & Auth Guards | 26/26 PASS | 26/26 PASS | **PASS** |
| B4 Scoped Data Repositories & Server Boundary | 5/5 PASS | 5/5 PASS | **PASS** |
| B5 Real Database & Concurrency Suite | 6/6 PASS | 6/6 PASS | **PASS** |
| B5 Unit & State Machine Tests | 5/5 PASS | 5/5 PASS | **PASS** |
| B6 Route Bridge & Fail-Closed Routing | 4/4 PASS | N/A (LMS only) | **PASS** |
| B7 UI Variants & Minimal Homework MVP | 6/6 PASS | 6/6 PASS | **PASS** |
| Synthetic Provisioning Full Rehearsal | 9/9 PASS | 9/9 PASS | **PASS** |
| Second-Tenant Multi-Tenant Isolation | 7/7 PASS | 7/7 PASS | **PASS** |
| M0D Legacy Dependency Matrix Audit | 1/1 PASS | 1/1 PASS | **PASS** |
| Phase A PostgREST RPC Denial | 6/6 DENIED | 6/6 DENIED | **PASS** |
| Pre-M0C Acceptance Harness | 11/11 Validated | 11/11 Validated | **PASS** |
| Automated Secret Scanner (`scan-secrets.py`) | 0 Findings | 0 Findings | **PASS** |

---

## 9. Remaining Actions Requiring Real M0C Execution

The following production actions are strictly **NOT EXECUTED** and remain pending the final consolidated ChatGPT Work review:
1. `REAL_AGENCY_A_DOMAIN_ACTIVATION`: Production DNS mapping of Agency A domains.
2. `REAL_AGENCY_A_BANK_CONFIGURATION`: Production bank account and QR credentials configuration.
3. `REAL_AGENCY_A_PRINCIPAL_PROVISIONING`: Real production Agency A owner and staff user accounts.
4. `REAL_AGENCY_A_BUSINESS_SEED`: Live course and offering publishing for Agency A.
5. `REAL_AGENCY_A_POSITIVE_PLAYBACK`: Live production video playback lease issuance.
6. `REAL_AGENCY_A_TRAFFIC_ENABLEMENT`: Enabling public DNS and live student traffic.
7. `M0D_EXECUTION`: Production cutover and migration of existing learners.
8. `M0E_EXECUTION`: Deletion/retirement of legacy database tables and endpoints.
9. `AGENCY_B_PROVISIONING`: Onboarding of Agency B.
10. `AGENCY_C_PROVISIONING`: Onboarding of Agency C.

---

## 10. Exact Git Base and Final SHAs

- **LMS Repository**: `thienha336501903-a11y/yeunauan-lms-clone`
  - Branch: `feat/multi-agency-b2-b3`
  - Base SHA: `8354ca6dfe4de1c323d93e109de2de2e9b7c1443`
  - Final Review SHA: `80b1b03c3842bc1c4599c78d6e4017eae2c99ea9`

- **Commerce Repository**: `thienha336501903-a11y/yeunauan-commerce-clone`
  - Branch: `feat/multi-agency-b2-b3`
  - Base SHA: `78d1c8c78094f3ac770f2d34b1e8f0903e2d6d0a`
  - Final Review SHA: `9280109218eecf6e48a0a990ba7bc49259ee27c7`
