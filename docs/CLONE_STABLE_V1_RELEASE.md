# CLONE_STABLE_V1_RELEASE MANIFEST

## Release Details
- **Release Date**: 2026-08-08
- **Release Status**: ACCEPTED & LOCKED FOR DEVELOPMENT

## 1. Commerce System
- **Repository**: `https://github.com/thienha336501903-a11y/yeunauan-commerce-clone`
- **HEAD SHA**: `90c0f38fc21d059a87bc1afad137d40efb65248d`
- **Release Tags**: `CLONE_STABLE_V1`, `CLONE_STABLE_V1_ACCEPTED_20260808`
- **Vercel Project**: `yeunauan-commerce-clone` (`prj_9LIdNafm4JYpYCNA6ujbIlQs2Bh9`)
- **Production Deployment URL**: `https://yeunauan-commerce-clone.vercel.app`
- **Commerce Admin URL**: `https://yeunauan-commerce-clone.vercel.app/admin.html`

## 2. LMS System
- **Repository**: `https://github.com/thienha336501903-a11y/yeunauan-lms-clone`
- **HEAD SHA**: `e1ab6d794ae169a60778cd612d192592358696ec`
- **Release Tags**: `CLONE_STABLE_V1`, `CLONE_STABLE_V1_ACCEPTED_20260808`
- **Vercel Project**: `yeunauan-lms-clone`
- **Production Deployment ID**: `dpl_4AhCjD5whZx5QunUWmy8BJhHCU3Q`
- **Production Deployment URL**: `https://yeunauan-lms-clone.vercel.app`
- **LMS Admin URL**: `https://yeunauan-lms-clone.vercel.app/lms-admin.html`
- **Admin Email Allowlist**: `daubepnho116@gmail.com`

## 3. Database System (Supabase)
- **Project Name**: `yeunauan-clone-b04`
- **Project Ref**: `yyiavtiwtekkocqpephr`
- **Schema Classification**: `FUNCTIONALLY_COMPATIBLE_CLONE_WITH_FIXES`
- **Schema Notes**: Includes `orders.id DEFAULT gen_random_uuid()` auto-generation & RLS least-privilege security policy hardening.

### Verified Business Data Counts
- **Courses**: 7
- **Lessons**: 39
- **Student Enrollments**: 20
- **Orders**: 28
- **Site Config**: 73
- **Course Slug Mappings**: 6

## 4. Operational & Verification Matrix
- **Commerce**: PASS
- **Commerce Admin**: PASS
- **Registration E2E**: PASS
- **LMS**: PASS
- **LMS Admin**: PASS
- **Google OAuth**: PASS
- **Real Admin Login**: PASS (`daubepnho116@gmail.com`)
- **RLS & Security**: PASS
- **Shared Drive Media**: PASS (0 bytes duplicated)
- **Network Isolation**: PASS (0 writes to old production)
- **Secret Scan**: PASS

## 5. Rollback Procedures
To revert to this exact baseline deployment at any point in the future:
1. Git: `git checkout CLONE_STABLE_V1_ACCEPTED_20260808`
2. Vercel Commerce: `vercel promote dpl_at7c3a7iz --scope thienha100022653824678-stacks-projects`
3. Vercel LMS: `vercel promote dpl_4AhCjD5whZx5QunUWmy8BJhHCU3Q --scope thienha100022653824678-stacks-projects`
