# Hướng Dẫn Di Chuyển Hệ Thống Từ Google Sheets sang Supabase

Tài liệu này hướng dẫn chi tiết các bước thiết lập cơ sở dữ liệu trên Supabase, lấy thông tin khóa kết nối, cấu hình các biến môi trường trên Vercel và triển khai hệ thống sau khi chuyển đổi.

---

## Bước 1: Khởi Tạo Dự Án Trên Supabase

1. Truy cập vào trang quản trị [Supabase](https://supabase.com/) và đăng nhập (hoặc đăng ký tài khoản miễn phí).
2. Nhấp vào nút **New Project** (Dự án mới) để tạo một dự án.
3. Nhập các thông tin cần thiết:
   - **Name**: Nhập tên dự án (ví dụ: `landing-page-courses`).
   - **Database Password**: Đặt mật khẩu an toàn cho database (hãy lưu lại mật khẩu này).
   - **Region**: Chọn vùng gần với đối tượng học viên của bạn nhất (khuyên dùng `Singapore - ap-southeast-1`).
   - **Pricing Plan**: Chọn gói **Free** (Miễn phí).
4. Nhấp vào **Create new project** và đợi 1 - 2 phút để Supabase khởi tạo hạ tầng cơ sở dữ liệu.

---

## Bước 2: Chạy SQL Khởi Tạo Cấu Trúc Bảng (Schema)

Sau khi dự án đã sẵn sàng:
1. Tại thanh menu bên trái của trang quản trị Supabase, nhấp vào biểu tượng **SQL Editor** (biểu tượng chiếc bảng hoặc `>_`).
2. Nhấp vào **New query** để tạo một trang soạn thảo SQL trống.
3. Mở file [supabase_schema.sql](./supabase_schema.sql) trong mã nguồn dự án, sao chép toàn bộ nội dung của file này.
4. Dán nội dung SQL vừa sao chép vào trang soạn thảo của Supabase SQL Editor.
5. Nhấp vào nút **Run** (ở góc dưới cùng bên phải khung soạn thảo).
6. Hãy chắc chắn rằng bạn nhận được thông báo: `Success. No rows returned` (Thành công).
7. Bây giờ, các bảng `courses` (Lưu thông tin khóa học) và `orders` (Lưu thông tin đăng ký học viên) cùng dữ liệu mẫu đã được khởi tạo thành công. Bạn có thể kiểm tra dữ liệu bằng cách nhấp vào biểu tượng **Table Editor** ở thanh menu bên trái.

---

## Bước 3: Lấy Khóa Kết Nối Supabase (Credentials)

1. Nhấp vào biểu tượng **Project Settings** (hình bánh răng cưa) ở góc dưới cùng menu bên trái.
2. Chọn menu **API** trong mục cấu hình.
3. Ở phần **Project API keys**, hãy tìm và sao chép 2 giá trị sau:
   - **URL**: Đây là địa chỉ dự án của bạn (sử dụng làm `SUPABASE_URL`).
   - **service_role (secret)**: Nhấp vào nút Reveal để hiển thị khóa bí mật đặc quyền này (sử dụng làm `SUPABASE_SERVICE_ROLE_KEY`).
   
> [!CAUTION]
> **Lưu ý bảo mật**: Khóa `service_role` có quyền đọc/ghi toàn bộ cơ sở dữ liệu và vượt qua các chính sách bảo mật (RLS). KHÔNG ĐƯỢC chia sẻ khóa này ra ngoài hoặc nhúng trực tiếp vào mã nguồn client/giao diện frontend.

---

## Bước 4: Cấu Hình Biến Môi Trường (Environment Variables) Trên Vercel

Truy cập vào trang quản lý dự án của bạn trên [Vercel](https://vercel.com/):
1. Chọn dự án tương ứng của bạn.
2. Chuyển sang tab **Settings** (Cài đặt) ở trên cùng.
3. Chọn menu **Environment Variables** (Biến môi trường) ở danh sách bên trái.
4. Thêm đầy đủ các biến môi trường sau đây:

| Tên Biến Môi Trường | Giá trị ví dụ / Hướng dẫn |
| :--- | :--- |
| `SUPABASE_URL` | Nhập địa chỉ **URL** lấy được từ Bước 3. |
| `SUPABASE_SERVICE_ROLE_KEY` | Nhập khóa **service_role (secret)** lấy từ Bước 3. |
| `ADMIN_PASSWORD` | Đặt mật khẩu của bạn để đăng nhập trang Admin (Ví dụ: `admin123`). |
| `CLOUDINARY_CLOUD_NAME` | Tên cloud Cloudinary của bạn (nếu có dùng). |
| `CLOUDINARY_API_KEY` | API Key của Cloudinary. |
| `CLOUDINARY_API_SECRET` | API Secret của Cloudinary. |

5. Nhấp **Save** (Lưu) cho mỗi biến môi trường đã thêm.

---

## Bước 5: Redeploy (Triển Khai Lại) Dự Án Lên Vercel

Để các biến môi trường mới có hiệu lực, bạn cần thực hiện triển khai lại (redeploy) dự án:
1. Trên trang quản lý dự án Vercel, chuyển sang tab **Deployments**.
2. Nhấp vào nút dấu 3 chấm dọc ở bản build mới nhất của bạn.
3. Chọn **Redeploy** và bấm xác nhận.
4. Đợi Vercel biên dịch và xuất bản phiên bản mới nhất.

---

## Bước 6: Kiểm Tra Luồng Hoạt Động (Flow) Sau Khi Deploy

1. **Trang Landing Page học viên**:
   - Truy cập vào: `https://ten-mien-cua-ban.vercel.app/?course=donut`
   - Đảm bảo trang hiển thị đầy đủ thông tin khóa học donut (ảnh, học phí, số tài khoản nhận tiền lấy trực tiếp từ bảng `courses` trong Supabase).
   - Hãy điền email thử nghiệm và tải lên một hình ảnh hóa đơn bất kỳ, sau đó bấm **Gửi đăng ký**.
   - Xác nhận có thông báo đăng ký thành công trên màn hình.

2. **Trang Quản lý Học viên (`orders.html`)**:
   - Truy cập vào: `https://ten-mien-cua-ban.vercel.app/orders.html`
   - Hệ thống sẽ hiển thị một hộp thoại nhập mật khẩu bảo mật được thiết kế lại đẹp mắt.
   - Nhập mật khẩu bạn đã cài đặt trong biến môi trường `ADMIN_PASSWORD` (ở Bước 4).
   - Đảm bảo bạn được dẫn vào Dashboard, thống kê tổng quan (số đơn chờ duyệt tăng lên 1 đơn do bạn vừa đăng ký thử ở trên).
   - Kiểm tra ảnh hóa đơn thu nhỏ, click để xem nhanh (lightbox preview) mà không bị chuyển hướng trang.
   - Thử bấm đổi trạng thái đơn từ "Chờ duyệt" thành "Đã duyệt" hoặc viết ghi chú nội bộ, bấm Lưu và tải lại trang để kiểm tra xem dữ liệu đã được cập nhật thành công lên database Supabase hay chưa.

3. **Trang Cấu hình Khóa học (`admin.html`)**:
   - Truy cập vào: `https://ten-mien-cua-ban.vercel.app/admin.html` (Mật khẩu được lưu trong phiên làm việc nên bạn sẽ không cần nhập lại).
   - Bạn sẽ nhìn thấy danh sách các khóa học hiện tại (bao gồm `donut` và `banh-mi`).
   - Thử tạo một khóa học mới với slug khác (ví dụ: `khoa-hoc-che`), sau đó truy cập `https://ten-mien-cua-ban.vercel.app/?course=khoa-hoc-che` để xem trang landing page tự động hiển thị khóa học mới này.
   - Thử chỉnh sửa thông tin thanh toán, giá hoặc bật/tắt kích hoạt khóa học để xem thay đổi có phản ánh ngay lập tức trên trang landing page của học viên hay không.
