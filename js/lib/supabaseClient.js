// Kết nối tới Supabase thật — xem docs/expense-app-setup.md để biết đầy đủ
// kiến trúc/lý do thiết kế.
//
// URL + anon key được PHÉP để công khai/commit vào repo — bảo mật thật nằm
// ở Row Level Security + Edge Function, không phải ở việc giấu 2 giá trị
// này. KHÔNG bao giờ đặt service_role key ở đây hay bất cứ file nào chạy
// trong trình duyệt.
//
// *** CẦN ĐIỀN LẠI 3 GIÁ TRỊ DƯỚI ĐÂY sau khi tạo project Supabase mới cho
// app "Sổ Chi Tiêu" (xem docs/expense-app-setup.md mục 1 và 4) — 3 giá trị
// đang để rỗng/placeholder vì đây là project MỚI, chưa từng tạo. ***
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://iswfooouxpzcijynvalv.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlzd2Zvb291eHB6Y2lqeW52YWx2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0NDA0NjgsImV4cCI6MjEwNDAxNjQ2OH0.FKcs3E2Y341ODpGZn7ooqEX5aV9ARQw1B6eKq1hReWU';

// URL thật của Edge Function DUY NHẤT (gộp login + tự đổi mật khẩu + quản lý
// thành viên vào chung 1 function cho đỡ phải deploy nhiều chỗ) — LƯU Ý tên
// hiển thị trên Dashboard có thể khác đường dẫn thật tùy cách tạo function.
export const API_FN_URL = 'https://iswfooouxpzcijynvalv.supabase.co/functions/v1/create-account';

// state.js gọi getSupabaseClient() ở ĐẦU HẦU NHƯ MỌI HÀM đọc/ghi (hàng chục chỗ) — trước đây mỗi
// lần gọi lại tự new createClient(...) MỘT LẦN NỮA dù JWT y hệt lần trước, tốn công dựng lại toàn
// bộ client (khởi tạo lại các client con bên trong) một cách vô ích mỗi lần thêm/sửa/xóa 1 giao
// dịch bất kỳ — đây chính là nguyên nhân cảm giác "chậm, phải chờ lâu". Giờ CACHE lại đúng 1 client
// cho mỗi JWT (JWT gần như không đổi suốt cả phiên đăng nhập, xem SESSION_HOURS ở Edge Function) —
// chỉ dựng lại client MỚI khi JWT thực sự đổi (đăng nhập lại/đổi phiên).
let cachedClient = null;
let cachedJwt = null;
/**
 * Lấy (hoặc tạo mới nếu chưa có/JWT đổi) 1 Supabase client — nếu có JWT riêng (do Edge Function cấp
 * sau khi xác minh mật khẩu) thì gắn vào header Authorization để RLS lọc đúng dữ liệu của đúng
 * người đó; không truyền gì thì chỉ có quyền của "anon" (gần như không đọc/ghi được gì, vì mọi bảng
 * đều yêu cầu đúng vé mới cho xem).
 */
export function getSupabaseClient(jwt) {
  const key = jwt || null;
  if (cachedClient && cachedJwt === key) return cachedClient;
  cachedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: key ? { headers: { Authorization: `Bearer ${key}` } } : {},
  });
  cachedJwt = key;
  return cachedClient;
}

/** Gọi thẳng Edge Function — dùng chung cho mọi "type", tự bọc lỗi mạng. `networkError: true` khi lỗi
 * rõ do MẤT MẠNG (không gọi được tới server) — để nơi gọi (VD hàng đợi đồng bộ mirror khi mất mạng
 * trong state.js) phân biệt được với lỗi THẬT (server trả lời nhưng từ chối) mà tự xếp hàng thử lại
 * sau thay vì coi là thất bại hẳn. */
async function callApi(authToken, payload) {
  try {
    const res = await fetch(API_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${authToken || SUPABASE_ANON_KEY}` },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, networkError: true, reason: 'Không kết nối được máy chủ, kiểm tra lại mạng và thử lại.' };
  }
}

/** type: 'login' — không cần JWT sẵn có, đây là chỗ tạo ra JWT. Trả về { ok, token, id, role, name, mustChangePassword, reason }. */
export async function callLoginFunction({ identifier, password }) {
  return callApi(null, { type: 'login', identifier, password });
}

/** Mọi "type" khác (tự đổi mật khẩu, owner tạo/sửa/xóa member...) — 'verify-own-password'/'set-own-password' chỉ cần JWT hợp lệ, còn lại cần JWT của owner. */
export async function callAccountFunction(ownJwt, payload) {
  return callApi(ownJwt, payload);
}
