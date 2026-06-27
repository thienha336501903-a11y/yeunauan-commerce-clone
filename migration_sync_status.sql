-- KỊCH BẢN MIGRATION SQL CHO HỆ THỐNG 2 (WEB BÁN HÀNG)
-- Chạy đoạn script này trong Supabase SQL Editor của Hệ thống 2

-- 1. Bổ sung các cột trạng thái đồng bộ vào bảng courses (Khóa học)
alter table courses add column if not exists sync_lms_status text default 'PENDING';
alter table courses add column if not exists sync_portal_status text default 'PENDING';
alter table courses add column if not exists sync_error text;

-- 2. Bổ sung các cột trạng thái đồng bộ vào bảng orders (Đơn đăng ký / Học viên)
alter table orders add column if not exists sync_lms_status text default 'PENDING';
alter table orders add column if not exists sync_portal_status text default 'PENDING';
alter table orders add column if not exists sync_error text;
