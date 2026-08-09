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
