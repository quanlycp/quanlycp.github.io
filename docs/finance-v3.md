# Quản lý dòng tiền và công nợ — finance-v3

## Sử dụng

- **Tổng quan**: số dư tiền quỹ lũy kế đến hôm nay; chênh lệch thu–chi của tháng; nợ phải trả và phải thu của quỹ. Không cộng khoản phải thu chưa nhận vào tiền hiện có.
- **Sổ dòng tiền**: mọi khoản tiền vào/ra, gồm vay, trả gốc, cho vay và thu hồi gốc. Tổng doanh thu/chi phí loại trừ các khoản gốc này.
- **Tổng kết tháng**: xem tháng/năm cũ, đối chiếu tiền đầu kỳ, phát sinh trong kỳ, tiền cuối kỳ, công nợ cuối kỳ. Dữ liệu giao dịch lưu trên máy chủ, báo cáo tính từ lịch sử; không xóa/reset khi đổi tháng hoặc năm. Đây là báo cáo có thể tính lại khi sửa lịch sử, không phải bản chốt sổ bất biến.
- **Công nợ**: hai mục quỹ chung và hai mục cá nhân. Khoản đối ứng riêng của thành viên cho quỹ mượn không được cộng thành phải thu của quỹ.
- Khi có tiền chuyển thực tế ở công nợ chung, giữ tích **Tiền thực nhận/chi từ quỹ**. Khi chỉ ghi nợ từ trước hoặc mua/bán chịu không chuyển tiền, bỏ tích để không cộng tiền hai lần. Khoản mua/bán chịu cần ghi nhận thu/chi theo chính sách của sổ; bản này quản lý tiền thực thu/thực chi, không phải hệ thống kế toán dồn tích.
- Tiền lãi ghi thành khoản thu/chi riêng, không nhập gộp vào tiền gốc. Khoản trả gốc chỉ giảm nợ gốc.
- Có thể khai báo **Số dư ban đầu** một lần, trước hoặc cùng ngày giao dịch đầu tiên. Sửa khoản này trong Sổ dòng tiền nếu nhập sai; không khai báo thêm mỗi tháng.

## Công thức

Chênh lệch = thu nhập − chi phí.

Tiền cuối kỳ = tiền đầu kỳ + thu nhập − chi phí + tiền vay − gốc trả − tiền cho vay + gốc thu hồi + số dư ban đầu khai báo trong kỳ.

Nợ cuối kỳ tính toàn bộ lịch sử đến cuối kỳ, không chỉ phát sinh trong tháng. Tiền và công nợ chuyển tiếp cả qua năm mới.

## Dữ liệu và tương thích

Không cần chạy SQL hoặc đổi quyền truy cập. `transactions.id` hiện là text; các giao dịch tiền gốc mới dùng namespace `txn_borrow_`, `txn_repay_`, `txn_lend_`, `txn_collect_`; số dư ban đầu dùng `txn_opening_`. Phần ngẫu nhiên vẫn do `genId` tạo. Loại nghiệp vụ ổn định khi đổi danh mục hoặc khi máy khác chưa tải được liên kết công nợ. Không phân loại từ nội dung ghi chú tự do.

Giao dịch cũ dùng danh mục hệ thống borrow/repay hoặc liên kết **công nợ chung** để phân loại lại khi đọc; không phát sinh giao dịch bù hoặc cộng tiền lần nữa. Giao dịch cũ không có các dấu hiệu đó giữ nguyên phân loại, cần kiểm tra thủ công nếu đã ghi tiền vay vào danh mục thu/chi thông thường. Liên kết riêng bị RLS ẩn với tài khoản khác không được dùng để thay đổi kết quả báo cáo của quỹ.

Tiền gốc mới thuộc sổ riêng (nếu được gọi từ API cũ) dùng `txn_private_*` và không cộng vào quỹ chung. Giao diện cá nhân mới mặc định chỉ ghi công nợ, không tạo dòng tiền chung. Namespace này là phân loại nghiệp vụ, không phải cơ chế phân quyền; quyền dữ liệu vẫn do RLS trên máy chủ quyết định.

Nhập/sửa/xóa giao dịch và công nợ phải thu/phải trả dùng outbox lưu bền vững trên thiết bị. Khi mất mạng, vẫn lưu được và mở lại được; khi có mạng, gửi lần lượt và đọc lại dữ liệu máy chủ. Cần mở ứng dụng trực tuyến ít nhất một lần để lưu phần giao diện ngoại tuyến. Không xóa dữ liệu trình duyệt khi còn thay đổi chưa đồng bộ.

## Kiểm tra

`node --experimental-vm-modules --test tests/*.test.cjs`

Bao gồm ví dụ 5 triệu thu, 3 triệu chi, vay 10 triệu, trả gốc 2 triệu; chuyển tháng/năm; cho vay/thu hồi ngoại tuyến; khởi động lại; hai thiết bị; dữ liệu cũ; nợ riêng đối ứng; số dư âm ban đầu; chặn thu vượt nợ và sửa/xóa gốc thấp hơn khoản đã thanh toán. Kiểm thử đồng bộ dùng máy chủ giả lập, không tạo giao dịch thử trên dữ liệu thật.

## Bổ sung finance-v3.1

- Ghi nợ chung mới: chọn thành viên cụ thể để tự ghi khoản đối ứng vào “Tôi phải thu” của đúng tài khoản sau đồng bộ. Chọn người ngoài thì chỉ ghi nợ chung; tên giống thành viên không tự tạo liên kết.
- “Trả khoản nợ khác (không theo dõi trong Công nợ)” được tính vào chi phí, biểu đồ và ngân sách như khoản chi bình thường. Khoản trả gắn với nợ chung đang theo dõi vẫn chỉ giảm tiền và nợ gốc. Quy tắc này cũng áp dụng cho giao dịch cũ thuộc danh mục Trả nợ không có liên kết nợ chung.
- Hai thẻ tổng quan dùng nhãn “Nợ phải trả”, “Nợ phải thu”; nút thao tác dùng “Mượn Nợ”, “Trả Nợ”. Phạm vi số liệu vẫn là quỹ chung.
