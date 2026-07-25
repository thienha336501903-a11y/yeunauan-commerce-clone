# Báo cáo Cổng 2–3 — Multi-storefront `yeunauan` / `yeubep`

Ngày: 2026-07-25  
Trạng thái: Cổng 2 hoàn tất; Cổng 3 Preview hoàn tất; dừng chờ owner duyệt.  
Không thực hiện: migration production, production data write, LMS change, domain/DNS/TXT change, production promotion.

## 1. Git và baseline

- Repository: `thienha100022653824678-stack/web-ban-hang-chinh-thuc`
- Baseline exact SHA: `cafe21bbe55af86bfb8ac2ebe9155ded849452e8`
- Branch riêng: `feature/yeubep-shop`
- Worktree: `C:\Users\gaomi\Downloads\Telegram Desktop\web-ban-hang-chinh-thuc\_worktrees\yeubep-storefront`
- Commit tính năng: `d7d4d81684a7dbd18932a65d1ce41b1b3d0bb0dd`
- Commit sửa khởi tạo fixture Preview: `2a4960a71d2aa71431fd1bec004eb8db5e47f979`
- Worktree sạch sau commit. Không merge và chưa push branch production.

Các worktree/WIP có sẵn không bị sửa. Không sử dụng `main`, `v2/platform-rebuild`, thư mục Portal `yeubep-shop` hoặc Vercel project Portal cùng tên.

## 2. Kiến trúc tenant đã triển khai

Allowlist server-side:

| Mã | Domain chuẩn |
|---|---|
| `yeunauan` | `https://shop.yeunauan.live` |
| `yeubep` | `https://yeubep.shop` |

Helper dùng chung tại `utils/sales-site.js`:

- `getSalesSiteConfig`
- `getDeploymentSalesSite`
- `getPublicSiteUrl`
- `buildCourseSalesUrl`
- `applyCourseTenantFilter`
- `applyOrderTenantFilter`
- `effectiveSalesSite`

Storefront lấy tenant từ `SALES_SITE` của deployment, không nhận tenant từ body/query/header của client.

- `yeunauan`: `sales_site = 'yeunauan' OR sales_site IS NULL`
- `yeubep`: chỉ `sales_site = 'yeubep'`
- Slug tenant khác trả 404.
- `courses.slug UNIQUE` toàn hệ thống được giữ nguyên.
- Legacy NULL được application coi là `yeunauan`; không backfill.

## 3. Schema, migration và rollback

Migration:

`migrations/20260725_multi_storefront_tenant.sql`

Thêm:

- `courses.sales_site`
- `orders.sales_site`
- `orders.sales_host`
- `orders.idempotency_key`
- `orders.price_snapshot`
- check constraint allowlist tenant
- index course tenant/active/sort
- index order tenant/course/status
- partial unique index `(sales_site, idempotency_key)` khi key khác NULL

Rollback:

`migrations/20260725_multi_storefront_tenant_rollback.sql`

Migration không backfill, không đổi/xóa global slug constraint, và idempotent.

### Database test an toàn

Migration được chạy trên PostgreSQL WASM cô lập bằng PGlite:

1. Tạo schema baseline tối thiểu.
2. Chèn course/order legacy.
3. Chạy migration lần 1.
4. Chạy migration lần 2.
5. Xác nhận legacy vẫn NULL.
6. Xác nhận tenant hợp lệ insert được.
7. Xác nhận tenant ngoài allowlist bị check constraint từ chối.
8. Xác nhận duplicate idempotency key cùng tenant bị unique index từ chối.
9. Chạy rollback.
10. Xác nhận toàn bộ column mới đã được xóa.

Kết quả: pass. Không kết nối hoặc ghi Supabase production `aqozjkfwzmyfunqvcyjv`.

## 4. Admin course

`admin.html` đã thêm field bắt buộc **WEBSITE BÁN HÀNG \***:

- `yeunauan.live` → `yeunauan`
- `yeubep.shop` → `yeubep`

Hành vi:

- Course legacy/NULL mở form ở `yeunauan.live`.
- Create/edit gửi allowlisted `sales_site`.
- Modal create reset tenant về `yeunauan`, không giữ state từ modal trước.
- Quick active, publish toggle và manual sync đều gửi lại tenant hiện tại.
- Đổi tenant hiện cảnh báo URL thay đổi và xác nhận đơn cũ không bị di chuyển.
- Link course dùng mapping tập trung theo tenant.
- Chỉ báo thành công khi response persisted có `id` và đúng `sales_site`; response sai không báo thành công.

API `courses` validate allowlist server-side, trả `sales_site` hiệu lực và `sales_url`. Update chỉ theo exact ID và `.select().single()`.

## 5. Public storefront

`api/config.js` áp dụng tenant filter tại query server/database trước khi trả course.

- Không tải tất cả course về browser để lọc.
- Course inactive hoặc cross-tenant trả 404.
- UI/poster/giá/bank/QR/checkout cũ được giữ nguyên.

Preview sử dụng fixture an toàn tại `utils/preview-fixture.js`. Fixture chỉ bật khi:

`COMMERCE_DATA_MODE=fixture`

Không có Supabase production secret trong Preview.

## 6. Tạo đơn và idempotency

`api/register.js`:

- Tenant lấy từ `SALES_SITE`.
- Course phải active và thuộc đúng tenant.
- ID/title/price lấy lại từ database.
- Bỏ qua title, price, tenant và host do client gửi.
- Lưu `sales_site`, canonical `sales_host`, `price_snapshot`, `idempotency_key`.
- Yêu cầu `Idempotency-Key` 16–128 ký tự theo allowlist ký tự.
- Retry cùng key/tenant trả order cũ.
- Partial unique index xử lý race/concurrent double-submit.
- Client giữ cùng key khi retry và sinh key mới sau thành công.
- Preview trả `dryRun: true`, không upload Cloudinary, không ghi DB thật.
- `EXTERNAL_SYNC_MODE=dry-run` chặn external sync trong Preview.

## 7. Orders admin isolation

`api/orders.js`, `api/approve-all.js`, `orders.html`:

- Mỗi order trả/hiển thị nguồn `yeunauan.live` hoặc `yeubep.shop`.
- Search/status/update/resync theo exact order ID sau admin auth.
- Course filter dùng composite `sales_site::slug`.
- Pending group dùng composite tenant + slug.
- Copy, count và approve group không trộn tenant.
- `approve-all` bắt buộc tenant allowlist và scope theo:
  - `course_slug`
  - effective `sales_site` (gồm NULL legacy cho yeunauan)
  - `status = 'Chờ duyệt'`
- Source fields không nằm trong payload update order nên admin update không đổi lịch sử nguồn.

## 8. LMS sync

Không sửa repository LMS, Supabase A hoặc `/api/sync`.

Contract/payload giữ nguyên:

- `syncCourse`
- `syncEnrollment`
- `revokeEnrollment`

Không thêm `sales_site`, `salesSite` hoặc `sourceSite` vào LMS payload. Preview không có LMS secret và chạy dry-run/fixture.

## 9. Test Gate 2

- `npm ci`: pass, 0 vulnerability.
- Full test: **50/50 pass**, 0 fail.
- HTML inline JavaScript compile:
  - `index.html`: pass
  - `admin.html`: pass
  - `orders.html`: pass
- `node --check` API/helpers: pass.
- `git diff --check`: pass.
- Secret scan: chỉ phát hiện placeholder cố ý trong test bảo mật cũ; không có secret thật trong source/bundle.

Local stub:

`http://127.0.0.1:4173`

Chạy bằng:

`npm run dev:stub`

Local integration result:

| Kiểm tra | Kết quả |
|---|---|
| Cross-tenant course | 404 |
| Create course `yeubep` | persisted `yeubep` |
| Read-after-write | `yeubep` |
| Client gửi tenant/host/title/price giả | bị bỏ qua |
| Order source | `yeubep` / `yeubep.shop` |
| Price snapshot | `299.000đ` từ course fixture |
| Retry cùng key | duplicate = true |
| Tổng order sau retry | 1 |
| Approve-all tenant sai | 0 |
| Approve-all tenant đúng | 1 |

## 10. Vercel Preview

- Team: `thienha100022653824678-stacks-projects`
- Project: `web-ban-hang-yeubep-shop`
- Project ID: `prj_l9vV0TI5AFN5yWSMzvNiLWzAnxq8`
- Node: 24.x
- Framework: Other
- Root: `.`
- Preview deployment ID: `dpl_2t5sidu6XZ59uK9MUZpBgKvZXirS`
- Preview URL: `https://web-ban-hang-yeubep-shop-d5hj9pm17.vercel.app`
- State: Ready
- Target: preview
- Deployment Protection: bật; người kiểm tra cần đăng nhập Vercel/team access.
- Không có custom domain.

Preview env names (không hiển thị value):

- `SALES_SITE`
- `PUBLIC_SITE_URL`
- `COMMERCE_DATA_MODE`
- `EXTERNAL_SYNC_MODE`
- `ADMIN_PASSWORD`

Effective Preview public URL được lấy từ system env `VERCEL_URL` khi `VERCEL_ENV=preview`, nên luôn khớp exact deployment URL; `PUBLIC_SITE_URL` là fallback cấu hình.

Preview smoke qua Vercel protection bypass:

| Endpoint/luồng | Kết quả |
|---|---|
| `/` | 200 |
| `/?course=yeubep-demo` | 200 |
| `/admin.html` | 200 |
| `/orders.html` | 200 |
| `/api/config?course=yeubep-demo` | 200 |
| `/api/config?course=legacy-demo` | 404 |
| Create order | success, `dryRun: true` |
| Retry cùng key | `duplicate: true`, cùng order ID |

### Sự cố deployment đầu tiên và xử lý

Lệnh deploy đầu tiên không có `--prod`, nhưng Vercel CLI tự gán deployment đầu tiên của project mới thành target production và alias `.vercel.app`.

- Artifact nhầm: `dpl_EgjL8uLNTGz1frZdDorRzFm1FLuU`
- Không có custom domain, database, payment hoặc secret production.
- Đã tạo lại deployment với `--target preview`.
- Đã xóa chính xác artifact nhầm.
- Preview `dpl_2t5sidu6XZ59uK9MUZpBgKvZXirS` vẫn Ready.
- Không còn alias custom nào của project mới.

## 11. Production/domain evidence sau Gate 3

Read-only probes:

| URL | Kết quả |
|---|---|
| `https://shop.yeunauan.live/` | 200 |
| course mẫu `thitxiennuongchaungoc` | 200 |
| `https://shop.yeunauan.live/admin.html` | 200 |
| `https://yeubep.shop/` | 200, vẫn project cũ |
| `https://www.yeubep.shop/` | 307 về apex |
| `https://www.daubepnho.store/` | 200 |

Alias `yeubep.shop` vẫn trỏ deployment cũ `web-ban-hang-chinh-thuc-7etvlx8t7.vercel.app`. Không Move/remove/claim domain, không đổi assignment, DNS, TXT, SPF, nameserver hoặc LMS.

## 12. Chưa thực hiện và bước phê duyệt tiếp theo

Chưa:

- push/merge branch production
- chạy migration Supabase production
- dùng dữ liệu/đơn/thanh toán production
- cấp enrollment
- cấu hình Supabase staging thật cho Preview
- promote production
- gắn custom domain
- Move ownership hoặc sửa DNS/TXT

Preview hiện chứng minh code/fixture và tenant boundary; chưa chứng minh read-after-write trên Supabase hosted staging thật. Trước Production cần owner duyệt Preview và cung cấp/phê duyệt Supabase staging/branch nếu muốn chạy hosted integration. Sau đó cần một phê duyệt riêng cho migration production, Production deployment và domain.
