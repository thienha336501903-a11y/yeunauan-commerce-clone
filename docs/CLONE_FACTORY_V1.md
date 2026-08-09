# CLONE_FACTORY_V1 SPECIFICATION & DOMAIN ISOLATION

## Overview
CLONE_FACTORY_V1 defines the standards for instantiating and isolating new e-commerce and LMS clones.

## Required Environment Parameters
Every clone deployment MUST explicitly configure the following canonical origin parameters:
- `COMMERCE_PUBLIC_URL`: Primary origin URL for storefront and Commerce Admin (e.g. `https://yeunauan-commerce-clone.vercel.app`).
- `LMS_PUBLIC_URL`: Primary origin URL for LMS student portal and LMS Admin (e.g. `https://yeunauan-lms-clone.vercel.app`).

## Domain Isolation & Denylist Rule
The factory and build validation MUST enforce that clone navigation URLs DO NOT match any protected old Production domain.

### Protected Old Production Domains (Denylist):
- `shop.yeunauan.live`
- `daubepnho.store`
- `www.daubepnho.store`

### Pre-Release Scan Requirement:
Before releasing any clone build:
1. Scan generated navigation URLs, links, COPY button origins, and API responses.
2. If any hardcoded navigation link points to a denylisted domain:
   **FAIL & STOP**: `STOP — DOMAIN ISOLATION FAILED`

## Cloudinary Configuration & Pre-Release Gate

### Required Environment Parameters:
- `CLOUDINARY_CLOUD_NAME`: Cloudinary account cloud name.
- `CLOUDINARY_API_KEY`: Cloudinary API key.
- `CLOUDINARY_API_SECRET`: Cloudinary API secret.

### Verification Gate:
- Every clone deployment MUST configure Cloudinary credentials across ALL Vercel target environments (**Production**, **Preview**, **Development**).
- `CLOUDINARY_AUTH_TEST = PASS`: Before declaring a clone operational, run a synthetic upload test against `/api/upload`.
- If Cloudinary authentication returns:
  `Invalid api_key`
  The deployment MUST fail immediately with error:
  **STOP — CLOUDINARY CONFIG FAILED**

## Course Creation & UUID Fallback Compatibility

### UUID Generation Standard:
- Every API endpoint inserting into clone tables (`courses`, `lessons`, `student_enrollments`, `orders`, `course_slug_mappings`, `site_config`) MUST supply an explicit fallback UUID (e.g. `req.body.id || crypto.randomUUID()`) when `id` is omitted in the request payload.
- This guarantees full execution compatibility regardless of whether database column defaults are configured.

### Verification Gate:
- `COURSE_CREATE_SCHEMA_COMPATIBILITY = PASS`: Before releasing any clone build, perform an end-to-end synthetic course lifecycle test (POST create course, PUT edit course, DELETE course).
- If course creation fails with `null value in column "id" of relation "courses" violates not-null constraint`, the release gate MUST fail with:
  **STOP — COURSE CREATE SCHEMA INCOMPATIBLE**

## Sync Architecture & Isolation Gates

### Sync Configuration Model:
```json
"sync": {
  "mode": "clone-internal|disabled",
  "internalSecretMode": "generate",
  "portalEnabled": false
}
```

### Factory Rules:
1. **Clone-Internal Sync Mode (`sync.mode = clone-internal`)**:
   - Generate a unique, clone-specific `INTERNAL_SYNC_SECRET`.
   - Set the identical `INTERNAL_SYNC_SECRET` on both Commerce and LMS clone services across all Vercel environments (**Production**, **Preview**, **Development**).
   - Point `SYSTEM3_URL` / `LMS_PUBLIC_URL` strictly to `https://yeunauan-lms-clone.vercel.app`.
2. **Unconfigured / Disabled Portal (`portalEnabled: false`)**:
   - When no Portal clone exists (`SYSTEM1_URL` is omitted), sync helpers MUST cleanly mark Portal sync status as `DISABLED` or `NOT_CONFIGURED` without raising error states.
   - Missing `INTERNAL_SYNC_SECRET` or unconfigured sync targets MUST NEVER generate red runtime errors when sync is disabled.

### Pre-Release Verification Gates:
- `INTERNAL_SYNC_CONFIG = PASS`: Both Commerce and LMS clones share identical valid `INTERNAL_SYNC_SECRET`.
- `SYNC_TARGET_ISOLATION = PASS`: Commerce → LMS sync targets `https://yeunauan-lms-clone.vercel.app` exclusively.
- `OLD_SYNC_TARGET = ZERO`: Zero sync requests targeted at old Production domains or old Supabase.
- `MISSING_SYNC_SECRET_ERROR = ZERO`: Zero `Missing INTERNAL_SYNC_SECRET` errors returned during course creation.

## Baseline Course Data Guard & Mutation Safety Rules

### Real Course Mutation Guard:
1. **Synthetic Course Identity Standard**:
   - All synthetic test courses MUST use slugs prefixed with `__clone_factory_test_` (e.g. `__clone_factory_test_<uuid>`).
   - Cleanup scripts MUST target ONLY exact IDs/slugs matching `__clone_factory_test_`.
   - BROAD OR COUNT-BASED `DELETE` AND `UPDATE` OPERATIONS ARE STRICTLY FORBIDDEN.
2. **Fingerprint Verification**:
   - Automated tests MUST calculate a pre-test fingerprint over the 7 canonical baseline course rows before executing synthetic operations.
   - Post-test verification MUST confirm that `BASELINE_COURSE_FINGERPRINT_BEFORE === BASELINE_COURSE_FINGERPRINT_AFTER`.
   - If any canonical row is mutated or deleted:
     **FAIL & STOP**: `STOP — BASELINE COURSE DATA MUTATION`

### Verification Gate:
- `REAL_COURSE_MUTATION_GUARD = PASS`: Baseline 7 course rows (IDs, slugs, titles, prices, posters, sort_orders) remain 100% untouched after all pre-release tests.



