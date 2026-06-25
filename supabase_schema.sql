-- Kịch bản khởi tạo database cho hệ thống Bán Hàng / Đăng Ký Khóa Học
-- Sao chép toàn bộ nội dung này và chạy trong Supabase SQL Editor

-- 1. Tạo bảng courses (Khóa học)
CREATE TABLE IF NOT EXISTS courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  price TEXT,
  image_url TEXT,
  description TEXT,
  teacher_name TEXT,
  active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  raw_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Tạo bảng orders (Đơn đăng ký / Học viên)
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_slug TEXT NOT NULL,
  course_title TEXT,
  customer_name TEXT,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  proof_image_url TEXT,
  status TEXT DEFAULT 'Chờ duyệt',
  note TEXT,
  raw_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Tạo index để tối ưu truy vấn
CREATE INDEX IF NOT EXISTS idx_courses_slug ON courses(slug);
CREATE INDEX IF NOT EXISTS idx_orders_course_slug ON orders(course_slug);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- 4. Chèn dữ liệu mẫu cho khóa học mặc định (donut) và một số khóa học ví dụ
INSERT INTO courses (slug, title, price, image_url, active, sort_order, raw_data)
VALUES (
  'donut',
  'Pinterest Food Studio — Bánh Donut',
  '199.000đ',
  'https://images.unsplash.com/photo-1530601761230-c71509743e42?auto=format&fit=crop&q=80&w=800',
  true,
  1,
  '{
    "bankName": "MB Bank (Ngân hàng Quân đội)",
    "bankAccount": "0999999999",
    "bankOwner": "NGUYEN VAN A",
    "transferNote": "DONUT GMAIL_CUA_BAN",
    "qrImageUrl": "https://img.vietqr.io/image/MB-0999999999-compact.png?amount=199000&addInfo=DONUT"
  }'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO courses (slug, title, price, image_url, active, sort_order, raw_data)
VALUES (
  'banh-mi',
  'Khóa Học Bánh Mì Việt Nam Chuẩn Vị',
  '299.000đ',
  'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&q=80&w=800',
  true,
  2,
  '{
    "bankName": "Techcombank",
    "bankAccount": "1903456789012",
    "bankOwner": "NGUYEN VAN A",
    "transferNote": "BANHMI GMAIL_CUA_BAN",
    "qrImageUrl": "https://img.vietqr.io/image/TCB-1903456789012-compact.png?amount=299000&addInfo=BANHMI"
  }'::jsonb
)
ON CONFLICT (slug) DO NOTHING;
