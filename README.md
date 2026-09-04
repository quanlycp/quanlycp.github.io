# Sổ Chi Tiêu

Web app quản lý chi tiêu & kế hoạch ngân sách hàng tháng cho gia đình/cá nhân — thuần HTML/CSS/JS
(ES Module), **không cần build**, kết nối **Supabase (Postgres) thật** làm backend.

## Tính năng

- **Đăng nhập nhiều người dùng chung 1 sổ**: bạn là **chủ sổ (owner)**, có thể tạo thêm tài khoản
  **thành viên (member)** — vd: vợ/chồng, con cái — để cùng ghi chép. Mọi người dùng **chung 1 sổ
  chi tiêu duy nhất** (không tách riêng theo từng người), chỉ khác nhau ở quyền: chỉ owner mới
  thêm/xóa được tài khoản thành viên và sửa cài đặt chung.
- **Tổng quan (Dashboard)**: tổng thu/chi/số dư tháng này, **dự báo chi tiêu cuối tháng** (tính theo
  tốc độ chi tiêu hiện tại), cảnh báo danh mục vượt ngân sách, nhắc khoản định kỳ đến hạn chưa ghi
  sổ, danh sách giao dịch gần đây.
- **Giao dịch**: ghi nhanh khoản thu/chi (số tiền, danh mục, ngày, ghi chú), lọc theo loại/danh
  mục/người ghi, tìm theo ghi chú, sửa/xóa bất cứ lúc nào.
- **Ngân sách hàng tháng theo danh mục**: đặt hạn mức cho từng danh mục, xem % đã dùng bằng thanh
  tiến trình (đỏ khi vượt), sao chép hạn mức từ tháng trước chỉ với 1 nút bấm.
- **Danh mục thu/chi**: tự tạo sẵn 1 bộ danh mục thường dùng khi mới bắt đầu, tự chỉnh sửa/thêm
  mới (tên, biểu tượng, màu, hạn mức mặc định) bất cứ lúc nào.
- **Báo cáo**: biểu đồ tròn chi tiêu theo danh mục (thuần CSS, không cần thư viện ngoài), biểu đồ
  xu hướng thu/chi 6 tháng gần nhất.
- **Giao dịch định kỳ**: khai báo 1 lần (tiền điện, tiền nhà, lương...), app tự nhắc khi tới ngày
  trong tháng mà chưa ghi sổ — xác nhận là tự tạo giao dịch, không cần nhập lại từ đầu mỗi tháng.
- **Mục tiêu tiết kiệm**: đặt mục tiêu (số tiền, hạn hoàn thành), góp/rút theo dõi tiến độ bằng
  thanh phần trăm.
- **Quản lý User**: chỉ chủ sổ thấy — tạo tài khoản thành viên mới (mật khẩu tạm tự sinh), cấp lại
  mật khẩu, xóa tài khoản (không mất giao dịch đã ghi trong sổ chung).
- **Thông báo**: bật Thông báo đẩy (Web Push) trên từng thiết bị, soạn & gửi ngay 1 thông báo cho
  1 người khác/tất cả mọi người/chính mình, hoặc đặt **lịch nhắc** tới đúng ngày giờ mới tự động
  gửi — nhận được cả khi không mở app (cần cấu hình thêm, xem `docs/expense-app-setup.md` mục 10).

## Chạy thử

```bash
node server.js 8080
```
Mở `http://localhost:8080`.

## Kết nối backend (Supabase)

App kết nối **Supabase (Postgres) thật** qua 1 Edge Function duy nhất
(`supabase/functions/create-account/`) xử lý đăng nhập + mọi thao tác liên quan mật khẩu/tài khoản
ở phía server (băm mật khẩu, tự ký JWT — không dùng Supabase Auth/GoTrue), cộng với Row Level
Security lọc dữ liệu cho các thao tác không nhạy cảm (giao dịch, danh mục, ngân sách...).

**Cần tạo 1 project Supabase MỚI cho app này** (không dùng chung với project khác) — hướng dẫn đầy
đủ từng bước (schema SQL, RLS, deploy Edge Function, tạo tài khoản owner đầu tiên): xem
**`docs/expense-app-setup.md`**.

## Trước khi dùng thật

1. Tạo project Supabase mới + làm theo `docs/expense-app-setup.md`, điền lại `js/lib/supabaseClient.js`.
2. Đổi mật khẩu owner ngay sau lần đăng nhập đầu (app tự bắt đổi).
3. Không có OTP/SMS — bảo mật dựa trên mật khẩu băm (SHA-256 có muối) + JWT ký ở server, phù hợp
   quy mô gia đình/cá nhân; cân nhắc thêm lớp bảo mật khác nếu dùng cho nhóm lớn hơn.
