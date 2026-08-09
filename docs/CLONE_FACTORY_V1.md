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
