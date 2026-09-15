# Sửa đồng bộ giao dịch giữa các thiết bị — sync-v2

## Nguyên nhân tìm thấy trong mã

- `addTransaction()` lưu cache trước khi gọi mạng nhưng chỉ tạo outbox sau lỗi mạng. Đóng trang giữa hai bước để lại giao dịch chỉ có trên máy.
- Máy nhận chỉ thử gửi outbox của chính nó; không định kỳ kéo giao dịch của người khác.
- `refresh()` hủy cập nhật tất cả bảng khi một bảng phụ bị lỗi.
- Bỏ tải cả bảng đang có outbox khiến giao dịch mới của người khác không xuất hiện; ẩn mục `stuck` khỏi số chờ gửi có thể báo hoàn tất sai.
- Thư viện từ CDN không nằm trong cache ngoại tuyến. Truy vấn không phân trang cũng bỏ sót dữ liệu khi vượt giới hạn phản hồi của Supabase.

## Hành vi sau sửa

1. Mỗi thao tác giao dịch được ghi vào một khóa outbox riêng trước request mạng. Tab khác lưu cache không thể xóa khóa này. Web Locks tuần tự hóa việc gửi giữa các tab khi trình duyệt hỗ trợ.
2. Chỉ bỏ thao tác sau xác nhận máy chủ. INSERT/UPDATE yêu cầu hàng trả về; lỗi UNIQUE chỉ được coi là lần gửi lại thành công khi tìm thấy chính bản ghi với đúng nội dung. Lỗi vẫn giữ trong hàng đợi và hiển thị rõ.
3. Khi app đang mở, mỗi 5 giây gửi việc chờ rồi kéo dữ liệu chung, kể cả máy có outbox rỗng. Có mạng lại, quay lại cửa sổ hoặc chuyển trang cũng tải lại. App bị đóng hoàn toàn sẽ tiếp tục khi mở lại.
4. Dữ liệu tải được gộp với INSERT/UPDATE/DELETE chưa gửi, không bỏ qua cả bảng. Lỗi một bảng không chặn các bảng khác. Các truy vấn phân trang theo khóa ổn định; phản hồi cũ không được đè thay đổi vừa ghi hoặc phiên đăng nhập mới.
5. Người đang gõ hoặc mở hộp thoại không bị vẽ lại form bởi lần tải nền. Tự cập nhật phiên bản cũng không tải lại trang khi còn giao dịch chờ gửi.
6. SDK Supabase được cố định ở 2.116.0 và lưu cùng website. Service worker tải sẵn HTML, CSS, JS và biểu tượng để mở lại ngoại tuyến sau lần cài thành công.

Thao tác chờ gửi giữ tài khoản người ghi. Đổi tài khoản không làm mất outbox, nhưng cần đăng nhập lại tài khoản đã ghi để gửi những thao tác của họ. Giao dịch là dữ liệu của **sổ chung**; quyền truy cập công nợ riêng vẫn theo RLS hiện có.

## Giao dịch đã mắc kẹt ở bản cũ

Lần nâng cấp đầu giữ bản sao giao dịch cache cũ, đối chiếu với máy chủ. Nếu có khoản chỉ tồn tại trên máy, banner **“Kiểm tra và khôi phục”** cho xem ngày, ghi chú và số tiền để chọn gửi lại bằng chính ID cũ. Không tự tái tạo mọi dòng vắng trên máy chủ vì đó có thể là khoản đã được xóa có chủ đích ở máy khác. Không xóa dữ liệu trình duyệt trước khi xử lý những khoản này.

## Kiểm thử

Chạy bằng Node.js 22 trở lên, không cần cài gói:

```sh
npm test
```

Kiểm thử tích hợp chạy mã `state.js` thật trong các môi trường trình duyệt giả lập độc lập, dùng máy chủ Supabase giả để điều khiển mất mạng và thời điểm trả lời. Bao gồm hai thiết bị/hai tài khoản, mở nhiều tab, tải lại giữa lúc gửi, khôi phục từ outbox khi cache chưa được lưu, đúng thứ tự sửa/xóa, xung đột UNIQUE, RLS từ chối, hết dung lượng lưu, đổi phiên, đọc cũ chồng lên ghi mới, bảng phụ thiếu và hơn 1.000 giao dịch. Kiểm thử riêng dùng SDK Supabase thật để xác nhận JWT và phản hồi INSERT, cùng mô phỏng service worker phục vụ từ cache khi mất mạng.

Đây không phải xác nhận dữ liệu hoặc RLS của project Supabase đang chạy. Kiểm tra nghiệm thu sau khi triển khai:

1. Hai thiết bị mở bản `2026-09-15 sync-v2`, đăng nhập owner và member của cùng sổ.
2. Máy A ngắt mạng, tạo giao dịch, tải lại trang: giao dịch và số chờ đồng bộ còn nguyên.
3. Máy A bật mạng, mở app và chờ banner hoàn tất. Máy B đang mở nhận giao dịch trong chu kỳ tải kế tiếp.
4. Thử sửa và xóa trên A, xác nhận B cập nhật; thử chiều ngược lại.
5. Nếu banner báo lỗi RLS, kiểm tra policy `transactions` ở mục 3 của `expense-app-setup.md`: cả `owner` và `member` đọc chung sổ theo claim `app_role`. Không mở quyền cho người chưa đăng nhập và không đặt service-role key vào website.

## Triển khai

Đưa các file trong bản sửa lên nhánh nguồn GitHub Pages như bình thường. Bản này không thay đổi schema hay Edge Function. Service worker đổi phiên bản cache để cài tài nguyên mới. Chạy `npm test` trước mỗi lần cập nhật mã.

Nếu chạy workflow `Sync from qtd` về sau, cần đưa bản sửa tương ứng sang nguồn `quytindungbn/qtd` trước để tránh workflow chép lại mã cũ.

Tài liệu SDK: [Insert và phản hồi bản ghi](https://supabase.com/docs/reference/javascript/insert), [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security).
