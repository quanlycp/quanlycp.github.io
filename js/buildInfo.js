// Đánh dấu PHIÊN BẢN code hiện tại — chỉ để KIỂM TRA xem máy đang mở có đang chạy đúng bản mới nhất
// hay không (hiện ở màn đăng nhập + sidebar), sau khi phát hiện gốc rễ của nhiều lần "sửa xong vẫn
// không thấy tác dụng" là do tab mở liên tục không tự kiểm tra lại code mới (xem app.js). Cập nhật
// giá trị này ở MỖI lần đẩy code lên — không cần chính xác tuyệt đối, chỉ cần ĐỔI để phân biệt được
// "đang chạy bản cũ hay mới" bằng mắt thường, khỏi phải đoán qua các dấu hiệu gián tiếp khác.
export const BUILD_VERSION = '2026-09-13 06:28';
