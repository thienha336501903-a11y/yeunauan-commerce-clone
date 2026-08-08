# CURRENT CLONE SYSTEM ARCHITECTURE

## Overview
This document defines the primary development architecture for the YeuNauAn e-commerce storefront and Learning Management System (LMS).

```
                 GitHub Clone Repos
             (thienha336501903-a11y)
                        │
         ┌──────────────┴──────────────┐
         ▼                             ▼
  Vercel Commerce                 Vercel LMS
(yeunauan-commerce-clone)    (yeunauan-lms-clone)
         │                             │
         └──────────────┬──────────────┘
                        ▼
                 Supabase Clone
             (yeunauan-clone-b04)
              yyiavtiwtekkocqpephr
                        │
                        ▼
               Google Drive Media
              (Shared Read-Only)
```

## Key Components

### 1. Source Repositories (GitHub)
- **Commerce**: `https://github.com/thienha336501903-a11y/yeunauan-commerce-clone`
- **LMS**: `https://github.com/thienha336501903-a11y/yeunauan-lms-clone`

### 2. Hosting & Deployment (Vercel)
- **Account**: `thienha100022653824678-stack`
- **Commerce Project**: `yeunauan-commerce-clone` (`https://yeunauan-commerce-clone.vercel.app`)
- **LMS Project**: `yeunauan-lms-clone` (`https://yeunauan-lms-clone.vercel.app`)

### 3. Database (Supabase)
- **Project Name**: `yeunauan-clone-b04`
- **Project Ref**: `yyiavtiwtekkocqpephr`
- **Access Model**: Independent database containing all 7 courses, 39 lessons, 20 enrollments, 28 orders, 73 site configs, and 6 slug mappings.

### 4. Course Media (Google Drive)
- **Media Access**: Shared read-only dependency streaming course videos via original Google Drive File IDs.
- **Deduplication**: 0 bytes of duplicate video storage; 100% media reuse.

## Isolation Guarantees
- **Old Production System (`shop.yeunauan.live`, `daubepnho.store`, Supabase `crphwjizolsgghapyjjv`)**: ZERO writes. The old production system is strictly read-only for reference/modeling purposes.
