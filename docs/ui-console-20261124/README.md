# Yêu học bánh Console — Admin commerce (24/11/2026)

Phạm vi: `admin.html` (Khóa học & mở bán), `orders.html` (Đơn hàng & học viên). Không đổi API, không đổi logic duyệt/đơn/quyền học.

## Design System (một nguồn)

- `design/console.head.html`: font Plus Jakarta Sans, `tailwind.config` (nền trắng + dải bạc hà, teal thay hồng, chữ xanh đậm, vàng nhấn; bo góc lớn; chữ 800) và CSS shell.
- Hai giao diện: **Bạc hà** (mặc định) và **Than & Cam** (sidebar đen, nhấn cam, font Inter). Màu Tailwind trỏ vào biến CSS `--p-*`/`--s-*`; mỗi giao diện là một bộ biến dưới `:root` / `:root[data-theme="ember"]`. Nút chuyển ở cuối sidebar; lựa chọn lưu theo trình duyệt (`localStorage` `yb-theme`), áp trước khi vẽ trang.
- `design/console.sidebar.html`: sidebar, menu điện thoại, link LMS lấy từ `/api/config?runtime=1`, Đăng xuất.
- `node scripts/sync-design.mjs` chép 2 khối vào các trang giữa marker `<!-- YB:HEAD -->` / `<!-- YB:SIDEBAR -->`. Worker chỉ phục vụ `*.html` ở gốc nên phải chép vào trang. `test/console-design.test.js` báo lỗi nếu trang lệch nguồn.
- Thêm trang mới vào Console: thêm 2 marker + `<body class="yb" data-page="...">`, thêm tên trang vào `DESIGN_PAGES`, chạy sync.

## Preview local (dữ liệu giả, không gọi ra ngoài)

```
node scripts/ui-preview.mjs 4317
```
Mở `http://localhost:4317/orders.html`, mật khẩu `preview-local`. Chạy handler `/api` thật trên Supabase giả trong bộ nhớ.

## Ảnh

`before-*.jpg` (bản `1c0a600`), `after-*.jpg` (desktop 1440, bảng màu teal/mint).

## Rollback

Nhánh `feat/ui-premium-20261124` (worktree `D:\SYSTEMB_WT\cf-commerce-ui`) tách từ `1c0a600`, đã push. Staging 24/11: `22d66059` (`a58af1b`, tông nâu); rollback staging `e04f1fee`. Bỏ nhánh: `git worktree remove D:\SYSTEMB_WT\cf-commerce-ui` rồi `git branch -D feat/ui-premium-20261124` trong `cf-commerce-h4`. Đã deploy sau này: quay lại bản Worker trước bằng `wrangler rollback <version>`.
