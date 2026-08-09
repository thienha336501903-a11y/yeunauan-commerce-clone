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

