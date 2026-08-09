# GITHUB REPAIR WORKFLOW HANDOFF DOCUMENTATION

## 1. Target Repositories & Local Paths

### Commerce Clone:
- **Repository URL:** `https://github.com/thienha336501903-a11y/yeunauan-commerce-clone.git`
- **Local Path:** `C:\Users\gaomi\Downloads\Telegram Desktop\web-ban-hang-chinh-thuc\_worktrees\prod-commerce-main-fa84d3a`
- **Remote Name:** `clone-origin`
- **Default Branch:** `main`
- **Current Main SHA:** `6d8527cbd5b0884f05feabb571bec12b25a3eb9c`
- **Active Repair Branch:** `fix/clone-runtime-isolation-batch`
- **Repair Branch SHA:** `181d11624c653ff9dcf5d13481b7a2d1d0ab4357`
- **Pull Request URL:** `https://github.com/thienha336501903-a11y/yeunauan-commerce-clone/pull/1`
- **Vercel Preview URL:** `https://yeunauan-commerce-clone-lh85rcc1r.vercel.app`
- **Canonical Production URL:** `https://yeunauan-commerce-clone.vercel.app`

### LMS Clone:
- **Repository URL:** `https://github.com/thienha336501903-a11y/yeunauan-lms-clone.git`
- **Local Path:** `C:\Users\gaomi\Downloads\Telegram Desktop\web-ban-hang-chinh-thuc\web-lms-chinh-thuc`
- **Remote Name:** `clone-origin`
- **Default Branch:** `main`
- **Current Main SHA:** `c70401af477f457dd1924999b20bc63a200734e4`
- **Active Repair Branch:** `fix/clone-runtime-isolation-batch`
- **Repair Branch SHA:** `c70401af477f457dd1924999b20bc63a200734e4`
- **Canonical Production URL:** `https://yeunauan-lms-clone.vercel.app`

---

## 2. Infrastructure & Database Identifiers

- **Supabase Clone Project Reference:** `yyiavtiwtekkocqpephr`
- **Supabase Clone Host:** `https://yyiavtiwtekkocqpephr.supabase.co`

---

## 3. Protected Resources (DO NOT TOUCH)

- Old Production Domains: `shop.yeunauan.live`, `daubepnho.store`, `www.daubepnho.store`
- Old Supabase Project Reference: `crphwjizolsgghapyjjv`
- Old Vercel Projects & Repositories
- Release Tags: `CLONE_STABLE_V1_ACCEPTED_20260808`

---

## 4. Current Repair Summary & Open Issues

### Resolved in Branch `fix/clone-runtime-isolation-batch`:
- **Issue:** Post-registration redirect in `index.html` redirected checkout users to `https://yeunauan.live/my-courses`.
- **Fix:** Replaced hardcoded URL with dynamic target `window.LMS_PUBLIC_URL || 'https://yeunauan-lms-clone.vercel.app'`.
- **File Changed:** `index.html`

---

## 5. Safe Read-Only Verification Commands

```bash
# Verify Database Baseline Counts (courses=7, lessons=39, enrollments=20, orders=28)
node _local_artifacts/read-only-supabase-audit.js

# Verify GitHub Account Authentication
gh auth status
gh api user --jq .login
```
