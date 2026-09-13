// ============================================================
// Lớp dữ liệu & nghiệp vụ trung tâm (state) cho app "Sổ Chi Tiêu" — kết nối
// Supabase thật (xem docs/expense-app-setup.md): đăng nhập, danh mục, giao
// dịch, ngân sách, giao dịch định kỳ, mục tiêu tiết kiệm, thành viên đều
// đọc/ghi qua Supabase (Edge Function cho thao tác nhạy cảm liên quan mật
// khẩu/tài khoản, còn lại đi thẳng qua Row Level Security). `state` object
// trong file này đóng vai trò CACHE trong bộ nhớ (+ lưu tạm vào localStorage
// để mở lại app không bị trắng trang / giữ được phiên đăng nhập) — mọi hàm
// ghi đều gọi Supabase trước, thành công mới cập nhật cache + notify() để
// vẽ lại màn hình.
// ============================================================
import { genId, colorAt, formatVND } from './utils.js';
import { getSupabaseClient, callLoginFunction, callAccountFunction } from './lib/supabaseClient.js';
import { subscribeThisDevice, unsubscribeThisDevice, getCurrentEndpoint } from './lib/push.js';

export const STORAGE_KEY = 'chitieu_v1';

export const CATEGORY_ICONS = ['home', 'cart', 'truck', 'store', 'film', 'heart', 'book', 'wallet', 'gift', 'trendingUp', 'building', 'tag'];

const DEFAULT_CATEGORIES = [
  { name: 'Ăn uống', type: 'expense', icon: 'cart' },
  { name: 'Di chuyển', type: 'expense', icon: 'truck' },
  { name: 'Nhà ở & hóa đơn', type: 'expense', icon: 'home' },
  { name: 'Mua sắm', type: 'expense', icon: 'store' },
  { name: 'Giải trí', type: 'expense', icon: 'film' },
  { name: 'Sức khỏe', type: 'expense', icon: 'heart' },
  { name: 'Giáo dục', type: 'expense', icon: 'book' },
  { name: 'Khác', type: 'expense', icon: 'tag' },
  { name: 'Lương', type: 'income', icon: 'wallet' },
  { name: 'Thưởng', type: 'income', icon: 'gift' },
  { name: 'Thu nhập khác', type: 'income', icon: 'trendingUp' },
];

// 2 danh mục HỆ THỐNG đặc biệt — chọn đúng 2 danh mục này lúc Thêm giao dịch sẽ tự hiện thêm các ô
// liên quan tới Công nợ (chọn chủ nợ/người nợ, đánh dấu nợ chung...), xem txnForm.js. Tự tạo lúc
// đăng nhập nếu project chưa có (xem ensureSpecialCategories bên dưới) — không tạo qua màn "Thêm
// danh mục" thường vì cột `special` không có trong form đó (tránh người dùng tự tạo nhầm thêm).
const SPECIAL_CATEGORIES = [
  { name: 'Mượn nợ', type: 'income', icon: 'creditCard', special: 'borrow' },
  { name: 'Trả nợ', type: 'expense', icon: 'creditCard', special: 'repay' },
];

let state = null;
const listeners = new Set();
function notify() { persist(); listeners.forEach((fn) => fn()); }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getState() { return state; }
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.error('Không lưu được dữ liệu', e); }
}
function emptyState() {
  return {
    settings: { householdName: 'Sổ chi tiêu của tôi', currency: 'đ' },
    users: [], categories: [], transactions: [], budgets: [], recurring: [], savingsGoals: [], plans: [], creditors: [], debtEntries: [],
    debtors: [], receivableEntries: [],
    notifications: [], notificationReads: [],
    session: null,
    outbox: [], // xem "Ngoại tuyến (offline)" phía dưới
    pendingMirrors: [], // bước "điền hộ" mirror còn chờ đồng bộ — xem "Ngoại tuyến (offline)" phía dưới
  };
}

// ------------------------------------------------------------
// Ngoại tuyến (offline): cho phép DÙNG APP + GHI DỮ LIỆU khi KHÔNG có mạng — mỗi thao tác ghi vẫn
// cập nhật NGAY vào bộ nhớ + localStorage (dùng được liền, không phải chờ mạng), đồng thời tự xếp
// vào 1 "hàng đợi" (outbox, cũng lưu trong localStorage nên sống sót qua việc tắt app/tắt máy) các
// việc còn phải gửi lên Supabase. Có mạng lại (sự kiện 'online', hoặc mỗi lần refresh()) tự động gửi
// hết hàng đợi lên ĐÚNG THEO THỨ TỰ đã ghi (quan trọng khi 1 dòng bị sửa/xóa nhiều lần lúc mất mạng,
// hoặc khi 1 dòng phụ thuộc khóa ngoại vào dòng ghi trước nó — VD debt_entries cần creditors đã có
// trước) — người khác sẽ thấy ngay sau khi đồng bộ xong. `created_at` được GHI SẴN ngay lúc thao tác
// (không để Supabase tự điền lúc đồng bộ) nên dù đồng bộ trễ, thời điểm hiển thị vẫn ĐÚNG lúc thao
// tác thật, không phải lúc có mạng lại. Mỗi thiết bị có hàng đợi RIÊNG (lưu trong localStorage của
// máy đó) nên nhiều tài khoản cùng ghi lúc mất mạng ở nhiều máy khác nhau vẫn tự đồng bộ đầy đủ, độc
// lập nhau, khi mỗi máy có mạng lại — không cần máy nào biết máy nào.
//
// Bước "điền hộ" mirror sang sổ riêng của thành viên (gọi Edge Function, KHÔNG phải ghi bảng trực
// tiếp nên không xếp chung vào outbox ở trên được) có hàng đợi RIÊNG — `state.pendingMirrors` — với
// cùng nguyên tắc: mất mạng thì xếp hàng, có mạng lại tự làm hộ, khỏi phải tự làm lại tay. Xử lý SAU
// khi outbox ở trên đã trống hẳn (đảm bảo creditor/dòng sổ nợ đã lên tới Supabase, vì bước mirror cần
// lưu con trỏ mirror_debtor_id/mirror_entry_id NGƯỢC LẠI vào đúng 2 bảng đó).
//
// LƯU Ý PHẠM VI: chỉ áp dụng cho Giao dịch + Mượn nợ/Trả nợ/Công nợ (mảng ghi dữ liệu chính, dùng
// nhiều nhất) — các mục khác (Danh mục, Ngân sách, Định kỳ, Tiết kiệm, Kế hoạch, Thông báo, Quản lý
// User, Cài đặt) vẫn cần có mạng như trước, có thể bổ sung sau nếu cần.
// ------------------------------------------------------------
/** Lỗi có phải do MẠNG không — để phân biệt với lỗi THẬT (dữ liệu sai, bị chặn quyền...): lỗi mạng
 * thì xếp hàng đợi gửi lại sau, lỗi thật thì phải báo ngay, không nên giấu vào hàng đợi.
 *
 * TRƯỚC ĐÂY chỉ dò theo TỪNG CHỮ cụ thể trong error.message (VD "failed to fetch") — cách này DỄ VỠ:
 * mỗi trình duyệt/hệ điều hành lại dùng đúng 1 câu chữ khác nhau cho lỗi mạng, chỉ cần thiếu 1 câu là
 * bị tính NHẦM thành "lỗi thật" (hiện đỏ oan ngay cả lúc đang mất mạng thật, đúng lỗi vừa báo). Giờ
 * dựa vào ĐÚNG BẢN CHẤT lỗi thay vì đoán câu chữ:
 * - Postgrest/Supabase trả lỗi THẬT (RLS từ chối, sai kiểu dữ liệu, vi phạm ràng buộc...) LUÔN kèm
 *   `code` (mã lỗi Postgres, VD '23505', '42501'...) — có `code` thì CHẮC CHẮN là lỗi thật, không
 *   phải lỗi mạng, bất kể message ghi gì.
 * - Lỗi Ở TẦNG MẠNG (mất mạng, DNS, timeout, CORS bị chặn...) do chính fetch() ném ra LUÔN là
 *   TypeError theo đúng chuẩn Fetch API — không phụ thuộc trình duyệt/hệ điều hành/message cụ thể.
 * Chỉ khi cả 2 cách trên đều không xác định được mới quay lại dò vài từ khóa quen thuộc làm phương án
 * dự phòng cuối cùng. */
function isNetworkError(error) {
  if (!error) return false;
  if (error.code) return false; // có mã lỗi Postgres -> chắc chắn lỗi thật, không phải lỗi mạng.
  if (error.name === 'TypeError') return true; // mọi lỗi cấp mạng của fetch() đều là TypeError.
  const msg = ((error.message) || '').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('load failed') || msg.includes('network') || msg.includes('econn') || msg.includes('timeout') || msg.includes('abort');
}
/** Gộp đủ thông tin 1 lỗi Postgrest/Supabase trả về (message + code + details + hint, nếu có) thành
 * 1 chuỗi để hiện lên banner/console — trước đây chỉ hiện mỗi `message` (thường chỉ 1 câu chung
 * chung như "new row violates row-level security policy"), thiếu hẳn `code`/`details`/`hint` vốn là
 * phần MANG NHIỀU THÔNG TIN CHẨN ĐOÁN NHẤT (VD `hint` hay nêu thẳng tên cột/ràng buộc liên quan). */
function describeError(error) {
  if (!error) return 'không rõ lỗi';
  const parts = [error.message || String(error)];
  if (error.code) parts.push(`mã: ${error.code}`);
  if (error.details) parts.push(`chi tiết: ${error.details}`);
  if (error.hint) parts.push(`gợi ý: ${error.hint}`);
  return parts.join(' — ');
}
function queueWrite(table, method, payload, match) {
  if (!Array.isArray(state.outbox)) state.outbox = []; // phòng hờ dữ liệu cache cũ/lỗi thiếu field này
  state.outbox.push({ id: genId('op'), table, method, payload: payload || null, match: match || null, createdAt: new Date().toISOString() });
  persist();
}
// Số lần thử lại (trong lúc THẬT SỰ đang online, xem syncOutbox()) trước khi coi 1 việc bị "kẹt" là
// đáng báo cho người dùng biết — dù vẫn bị coi là "lỗi mạng" (VD do CORS bị chặn, luôn ném y hệt lỗi
// "Failed to fetch" như mất mạng thật, KHÔNG cách nào phân biệt được từ phía trình duyệt) chứ không
// phải mất mạng thật, thì sau chừng này lần thử vẫn y hệt lỗi -> báo rõ thay vì "đang đồng bộ" mãi mãi
// mà không ai biết vì sao (vẫn giữ lại hàng đợi để tiếp tục thử, không rớt mất dữ liệu).
const STUCK_RETRY_WARN_AFTER = 4;
/** Xếp 1 việc mirror (điền hộ sang sổ riêng thành viên) còn dang dở vào hàng đợi riêng — xem
 * processPendingMirrors() phía dưới. `job.op`: 'add' (cần creditorId+entryId, tự tìm lại đúng dòng
 * đó lúc xử lý), 'update'/'delete' (cần mirrorEntryId — dòng mirror ĐÃ có sẵn từ trước, giờ cần sửa/
 * xóa theo). Luôn kèm `entryId` (dòng sổ nợ GỐC, kể cả 'update'/'delete') để có thể huỷ/gộp đúng job
 * khi dòng gốc đó bị sửa/xóa tiếp trong lúc vẫn đang mất mạng (xem updateDebtEntry/deleteDebtEntry). */
function queueMirrorJob(job) {
  if (!Array.isArray(state.pendingMirrors)) state.pendingMirrors = [];
  state.pendingMirrors.push({ id: genId('mirrorjob'), ...job });
  persist();
}
/** Xếp 1 việc mirror vào hàng đợi RỒI kích hoạt đồng bộ NGAY — dùng CHUNG đúng 1 đường cho cả lúc
 * online lẫn offline, thay vì tách riêng "thử ngay 1 lần, báo qua toast RIÊNG nếu lỗi" (online) với
 * "xếp hàng, tự làm khi có mạng" (offline) như trước. Lý do đổi: toast riêng cho lúc online rất dễ bị
 * bỏ lỡ (chỉ hiện ~2 giây, mất luôn dấu vết), trong khi hàng đợi chung đã có sẵn NGUYÊN 1 bộ máy đáng
 * tin cậy người dùng đang trực tiếp theo dõi. LUÔN gọi syncOutbox() ngay (không xét isOnline() —
 * không đáng tin cậy 100%, xem chú thích ở syncOutbox()) — nếu thật sự đang mất mạng thì bản thân lần
 * gọi mạng thật bên trong đó tự thất bại rồi giữ nguyên hàng đợi như thường, không tốn kém gì thêm.
 * Không await ở đây — chạy NỀN, khỏi chặn thao tác vừa làm. */
function queueAndKickMirror(job) {
  queueMirrorJob(job);
  syncOutbox();
}
function applyMatch(query, match) {
  if (!match) return query;
  for (const m of (Array.isArray(match) ? match : [match])) query = query.eq(m.column, m.value);
  return query;
}
/** Thử ghi thẳng lên Supabase (insert/update/delete). Mất mạng (hoặc lỗi rõ do mạng) -> tự xếp vào
 * outbox để gửi lại sau, coi như đã "lưu tạm" xong (KHÔNG throw) — nơi gọi vẫn cập nhật bộ nhớ/
 * localStorage của mình bình thường, chỉ là chưa lên tới Supabase. Lỗi THẬT thì trả lỗi để nơi gọi
 * tự throw như trước (không nên giấu lỗi thật vào hàng đợi, người dùng cần biết ngay). LUÔN thử gọi
 * mạng thật trước tiên — KHÔNG còn tự đoán qua isOnline() rồi bỏ qua bước thử (không đáng tin cậy
 * 100%, xem chú thích ở syncOutbox()); rõ ràng mất mạng thì bước thử này tự thất bại rất nhanh, không
 * đáng để đánh đổi lấy rủi ro đoán sai (queue oan 1 việc lẽ ra gửi được ngay lúc đang có mạng thật). */
async function tryWrite(sb, table, method, payload, match) {
  try {
    let q = sb.from(table);
    if (method === 'insert') q = q.insert(payload);
    else if (method === 'update') q = applyMatch(q.update(payload), match);
    else if (method === 'delete') q = applyMatch(q.delete(), match);
    const { error } = await q;
    if (error) {
      if (isNetworkError(error)) { queueWrite(table, method, payload, match); return { queued: true, error: null }; }
      return { queued: false, error };
    }
    return { queued: false, error: null };
  } catch (e) {
    // fetch tự throw exception (mất mạng giữa chừng) thay vì trả {error} như PostgREST thường làm.
    queueWrite(table, method, payload, match);
    return { queued: true, error: null };
  }
}
/** Số việc đang chờ đồng bộ — hiện lên giao diện (xem components/shell.js) để người dùng biết đang
 * có thay đổi CHƯA lên tới Supabase, tránh tưởng nhầm là mất dữ liệu hoặc app bị lỗi. KHÔNG đếm các
 * item đã bị đánh dấu `stuck` (lỗi THẬT lặp đi lặp lại nhiều lần, xem syncOutbox()) — 1 item như vậy
 * không còn ở trạng thái "đang chờ đồng bộ bình thường" nữa mà là "cần xem lại thủ công", nếu vẫn đếm
 * chung vào đây thì banner/toast "đã đồng bộ xong" cho MỌI việc khác (không liên quan) sẽ KHÔNG BAO
 * GIỜ hiện được — item đó vẫn được tự thử lại ở nền (phòng khi lỗi được sửa sau), chỉ là không tính
 * vào con số này nữa; lỗi của nó vẫn hiện riêng qua getSyncIssue() (banner đỏ). */
export function pendingSyncCount() {
  const activeOutbox = state.outbox.filter((op) => !op.stuck).length;
  return activeOutbox + (state.pendingMirrors ? state.pendingMirrors.length : 0);
}

// Lỗi THẬT (không phải do mất mạng) gặp phải lúc đồng bộ hàng đợi — trước đây gặp lỗi này chỉ
// console.warn() rồi ÂM THẦM giữ nguyên item đó ở ĐẦU hàng đợi mãi mãi (thử lại y hệt input cũ ở mỗi
// lần sync sau, luôn lỗi y hệt) -> CHẶN LUÔN mọi thay đổi ghi SAU nó (kể cả của người khác/thao tác
// khác) không bao giờ lên được, mà người dùng không hề biết vì không có gì báo cả — nhìn như "app bị
// treo lúc đồng bộ" hoặc "sao mãi không thấy lên". Giờ lưu lại để hiện rõ lên banner (components/
// shell.js) thay vì im lặng mãi. KHÔNG lưu vào localStorage (chỉ để hiện tạm thời trong phiên hiện tại).
let lastSyncIssue = null;
export function getSyncIssue() { return lastSyncIssue; }

let syncingOutbox = false;
/** Gửi hết hàng đợi lên Supabase theo ĐÚNG THỨ TỰ đã ghi, xong mới xử lý tiếp hàng đợi mirror (xem
 * processPendingMirrors — CHỈ chạy khi outbox chính đã trống hẳn, vì bước mirror cần creditor/dòng sổ
 * nợ đã thật sự tồn tại trên Supabase). Dừng lại (giữ nguyên phần còn lại) ngay khi gặp lỗi mạng — thử
 * lại ở lần gọi sau (sự kiện 'online', hoặc mỗi lần refresh()/vào trang Công nợ). An toàn gọi lặp lại
 * nhiều lần (tự bỏ qua nếu đang chạy dở hoặc cả 2 hàng đợi đang rỗng). */
export async function syncOutbox() {
  // KHÔNG có phiên đăng nhập (VD đã đăng xuất, hoặc chưa đăng nhập lần nào trên máy này) -> đừng thử
  // đồng bộ (không có token hợp lệ để ghi được gì) VÀ đừng gọi notify() ở finally bên dưới — trước đây
  // cứ hễ còn hàng đợi (VD đăng xuất giữa chừng lúc còn thay đổi chưa kịp lên Supabase) là hẹn giờ/sự
  // kiện 'online' liên tục gọi lại hàm này, notify() ở finally cứ thế vẽ lại MÀN ĐĂNG NHẬP (root.
  // innerHTML = ... trong renderLogin) TỪ ĐẦU mỗi vài giây — đúng lúc người dùng đang gõ dở tên đăng
  // nhập/mật khẩu thì bị "tải lại" xóa sạch input, y hệt phàn nàn "nhập gần xong bị tải lại mất dữ liệu".
  if (!getSession()) return;
  // KHÔNG còn chặn theo isOnline() ở đây nữa — navigator.onLine không phải lúc nào cũng đáng tin cậy
  // 100% (khác nhau tùy trình duyệt/cách mô phỏng mất mạng lúc test, có lúc báo sai cả 2 chiều: báo
  // "còn mạng" dù đang thật sự mất, hoặc ngược lại) — lỡ báo sai đúng lúc CÓ mạng lại thật thì hàm này
  // bị chặn mãi mãi, không bao giờ thử lại được nữa dù mạng đã có. Giờ cứ THỬ THẲNG, để chính kết quả
  // gọi Supabase thật (thành công/lỗi mạng/lỗi thật) quyết định, không dựa vào 1 cờ trạng thái có thể
  // sai của trình duyệt.
  if (syncingOutbox || (!state.outbox.length && !(state.pendingMirrors || []).length)) return;
  syncingOutbox = true;
  lastSyncIssue = null; // để mỗi lần thử lại đều đánh giá lại từ đầu, không giữ mãi thông báo lỗi cũ nếu đã hết lỗi
  try {
    const session = getSession();
    const sb = getSupabaseClient(session?.sbToken);
    // Giới hạn an toàn: đủ lượt bằng cả hàng đợi (x2 cho rộng rãi) thì DỪNG HẲN vòng lặp này dù chưa
    // xong — tránh treo trình duyệt vô thời hạn nếu lỡ NHIỀU item đều bị "đẩy xuống cuối" (xem dưới)
    // rồi vòng lại gặp nhau mãi trong CÙNG 1 lần gọi (không xảy ra trong thực tế thường thì, nhưng
    // phải chặn được về mặt lý thuyết).
    let cycles = 0;
    const cycleLimit = state.outbox.length * 2 + 4;
    while (state.outbox.length && cycles++ < cycleLimit) {
      const op = state.outbox[0];
      let q = sb.from(op.table);
      if (op.method === 'insert') q = q.insert(op.payload);
      else if (op.method === 'update') q = applyMatch(q.update(op.payload), op.match);
      else if (op.method === 'delete') q = applyMatch(q.delete(), op.match);
      let error = null;
      try { ({ error } = await q); } catch (e) { error = e; }
      if (error) {
        op.attempts = (op.attempts || 0) + 1;
        if (!isNetworkError(error)) {
          // Lỗi THẬT (VD RLS từ chối, thiếu cột, sai kiểu dữ liệu...) — KHÔNG phải cứ retry là tự hết.
          console.warn(`syncOutbox: lỗi THẬT (không phải mất mạng) trên bảng ${op.table}:`, error);
          lastSyncIssue = { message: `Lỗi đồng bộ (bảng ${op.table}): ${describeError(error)}` };
          if (op.attempts >= STUCK_RETRY_WARN_AFTER) {
            // Đã thử vài lần vẫn y hệt lỗi này — đánh dấu `stuck` để pendingSyncCount() (và banner/
            // toast "đã đồng bộ xong") không còn tính item này nữa, tránh việc 1 dòng không sửa được
            // ngay chặn đứng thông báo "xong" của MỌI thao tác khác không liên quan mãi mãi — vẫn giữ
            // nguyên trong hàng đợi (KHÔNG xóa, không mất dữ liệu) và tiếp tục tự thử lại ở nền.
            op.stuck = true;
          }
          if (op.attempts >= STUCK_RETRY_WARN_AFTER && state.outbox.length > 1) {
            // ĐẨY XUỐNG CUỐI hàng đợi để các việc KHÔNG LIÊN QUAN phía sau vẫn có cơ hội lên được,
            // thay vì bị đúng 1 dòng hỏng chặn đứng TẤT CẢ mãi mãi.
            state.outbox.shift();
            state.outbox.push(op);
            persist();
            continue;
          }
        } else {
          console.warn('syncOutbox: lỗi mạng, giữ lại thử lần sau:', error.message || error);
          if (op.attempts >= STUCK_RETRY_WARN_AFTER) {
            // Đang ONLINE (điều kiện để vào được hàm này) mà vẫn lỗi y hệt "mất mạng" sau ngần này lần
            // thử -> nhiều khả năng KHÔNG phải mất mạng thật (VD CORS/cấu hình chặn) — báo rõ, vẫn giữ
            // lại hàng đợi để tiếp tục tự thử (không rớt mất dữ liệu chưa lên được).
            lastSyncIssue = { message: `Vẫn chưa gửi được sau ${op.attempts} lần thử (bảng ${op.table}) dù đang có mạng — có thể do cấu hình chặn, không phải do mất mạng. Vẫn tiếp tục tự thử lại.` };
          }
        }
        persist(); // lưu lại op.attempts dù chưa bỏ item này khỏi hàng đợi
        break;
      }
      state.outbox.shift();
      persist();
    }
    // CHỈ cần không còn item ĐANG HOẠT ĐỘNG nào (chưa đánh dấu `stuck`) là đủ điều kiện xử lý tiếp
    // hàng đợi mirror — KHÔNG còn đòi hỏi outbox rỗng HẲN như trước (1 item `stuck` — lỗi thật lặp lại
    // nhiều lần — có thể không bao giờ tự hết, nếu vẫn bắt đợi nó mới xử lý mirror thì mirror của MỌI
    // thao tác khác, không liên quan, cũng bị chặn đứng mãi mãi theo, đúng lỗi "Người khác nợ tôi
    // không tự lên" đã gặp).
    if (!state.outbox.some((op) => !op.stuck)) await processPendingMirrors();
  } finally {
    syncingOutbox = false;
    notify();
  }
}

/** Chỉ đọc cache trong localStorage — KHÔNG đụng mạng, xong ngay lập tức. Gọi hàm này rồi vẽ màn
 * hình ra liền (dùng dữ liệu cũ tạm, khỏi phải nhìn "Đang tải..." lâu), sau đó gọi refresh() ở nền
 * để lấy dữ liệu mới nhất — refresh() xong sẽ tự notify() để vẽ lại với dữ liệu thật. */
export async function init() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try { state = JSON.parse(raw); } catch (e) { console.warn('Dữ liệu cache lỗi, tạo lại.', e); state = emptyState(); }
  } else {
    state = emptyState();
  }
  // Dữ liệu cache cũ (lưu TRƯỚC khi có tính năng offline này) sẽ THIẾU hẳn field `outbox` (và bất kỳ
  // field mới nào thêm sau này) vì JSON.parse() ở trên chỉ trả đúng những gì đã lưu trước đó -> phải
  // bù lại bằng giá trị mặc định của emptyState(), không thì các hàm gọi state.outbox.push(...) sẽ
  // ném lỗi "Cannot read properties of undefined" ngay khi thêm/sửa/xóa bất kỳ giao dịch nào.
  const defaults = emptyState();
  for (const key of Object.keys(defaults)) {
    if (state[key] === undefined) state[key] = defaults[key];
  }
}
/** Tải dữ liệu mới nhất từ Supabase ở NỀN (không chặn màn hình đầu tiên) — tên sổ (cho màn đăng
 * nhập) + toàn bộ dữ liệu phiên đang đăng nhập (nếu có). Xong tự notify() để vẽ lại. */
export async function refresh() {
  await loadSettingsPublic();
  if (state.session?.sbToken) {
    if (isTokenExpired(state.session.sbToken)) {
      // Phiên hiện sống rất lâu (xem SESSION_HOURS trong Edge Function) nên hiếm khi hết hạn thật,
      // nhưng vẫn có thể xảy ra (VD phiên đăng nhập từ TRƯỚC khi đổi sang thời hạn dài, hoặc chủ sổ
      // cấp lại mật khẩu ở thiết bị khác làm mất hiệu lực). Nếu để vậy gọi Supabase với token hết
      // hạn, Row Level Security sẽ âm thầm lọc MỌI bảng về RỖNG (0 dòng) mà KHÔNG báo lỗi gì cả,
      // trông y hệt "mất hết dữ liệu" dù dữ liệu vẫn còn nguyên. Chủ động phát hiện ở đây, đăng
      // xuất luôn để bắt đăng nhập lại lấy phiên mới, thay vì để người dùng hoang mang.
      sessionExpiredNotice = true;
      logout();
      return;
    }
    await syncOutbox();
    // Vẫn còn thay đổi CHƯA đồng bộ được lên Supabase (đang mất mạng, hoặc lỗi khác) -> KHÔNG được tải
    // đè lên ĐÚNG NHỮNG BẢNG đang có thay đổi cục bộ chưa gửi lên đó, vì loadSessionData() thay THẲNG
    // mảng bằng dữ liệu server. TRƯỚC ĐÂY hễ outbox còn BẤT KỲ gì (dù chỉ 1 dòng, ở 1 bảng bất kỳ) là
    // BỎ QUA HẲN việc tải lại — kể cả những bảng HOÀN TOÀN KHÔNG LIÊN QUAN (VD "Người khác nợ tôi" —
    // debtors/receivable_entries — chưa bao giờ được ghi qua outbox này cả, luôn ghi qua Edge Function
    // ở nơi khác) — khiến dữ liệu người khác ghi hộ (mirror) không bao giờ tự cập nhật được qua trang
    // Công nợ nữa, CHỈ thấy khi đăng nhập lại từ đầu (login() không đi qua đường này). Giờ chỉ bỏ qua
    // ĐÚNG các bảng đang có việc chờ, mọi bảng khác vẫn tải mới bình thường.
    const pendingTables = new Set(state.outbox.map((op) => op.table));
    try { await loadSessionData(state.session.sbToken, { strict: true, skipTables: pendingTables }); }
    catch (e) { console.warn('Không tải lại được dữ liệu phiên cũ.', e); }
  }
  persist();
  notify();
}

/** Đọc claim "exp" (Unix giây) trong JWT tự ký ở Edge Function mà KHÔNG cần xác minh chữ ký (chỉ để
 * quyết định có nên chủ động đăng xuất sớm hay không — chữ ký thật đã được server xác minh mỗi lần
 * gọi API, đây chỉ là kiểm tra hạn dùng phía trình duyệt). Đọc lỗi/thiếu "exp" -> coi như đã hết hạn. */
function isTokenExpired(token) {
  try {
    const payloadB64 = token.split('.')[1];
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return !payload.exp || payload.exp < Math.floor(Date.now() / 1000);
  } catch (e) {
    return true;
  }
}

// Cờ tạm (KHÔNG lưu localStorage, chỉ tồn tại trong phiên chạy này) để màn đăng nhập biết mà báo lý
// do bị đưa về đây — dùng consumeSessionExpiredNotice() để đọc rồi tự xóa (chỉ báo đúng 1 lần).
let sessionExpiredNotice = false;
export function consumeSessionExpiredNotice() {
  const v = sessionExpiredNotice;
  sessionExpiredNotice = false;
  return v;
}

async function loadSettingsPublic() {
  try {
    const sb = getSupabaseClient();
    const { data } = await sb.from('app_settings').select('*').eq('id', 'main').maybeSingle();
    if (data) state.settings = mapSettingsRow(data);
  } catch (e) {
    console.warn('Không tải được tên sổ từ Supabase.', e);
  }
}
function mapSettingsRow(row) {
  return { householdName: row.household_name, currency: row.currency || 'đ' };
}

// ------------------------------------------------------------
// Cài đặt sổ (tên sổ, đơn vị tiền) — chỉ owner sửa được (chặn bằng RLS)
// ------------------------------------------------------------
export function getSettings() { return state.settings; }
export async function updateSettings(patch) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const dbPatch = {};
  if (patch.householdName !== undefined) dbPatch.household_name = patch.householdName;
  if (patch.currency !== undefined) dbPatch.currency = patch.currency;
  const { error } = await sb.from('app_settings').update(dbPatch).eq('id', 'main');
  if (error) throw new Error('Không lưu được cài đặt, thử lại sau.');
  Object.assign(state.settings, patch);
  notify();
}

// ------------------------------------------------------------
// Đăng nhập / phiên làm việc
// ------------------------------------------------------------
export async function login(identifier, password) {
  const res = await callLoginFunction({ identifier, password });
  if (!res.ok) return { ok: false, reason: res.reason };
  try {
    // strict mặc định false (xem loadSessionData) — 1 bảng PHỤ lỗi (VD chưa setup đủ SQL/RLS cho 1
    // tính năng "Bổ sung sau" nào đó) KHÔNG chặn hẳn đăng nhập nữa, chỉ coi bảng đó là rỗng + cảnh
    // báo console. Nhánh catch này giờ chỉ còn bắt lỗi THẬT SỰ nghiêm trọng (VD mất mạng giữa chừng
    // ngay lúc vừa đăng nhập xong, hoặc lỗi không mong đợi trong seedDefaultCategories/
    // ensureSpecialCategories) — kèm nguyên văn lý do để còn biết đường sửa, không chỉ 1 câu chung chung.
    await loadSessionData(res.token);
  } catch (e) {
    console.warn('login: lỗi tải dữ liệu phiên, thử đăng nhập lại:', e);
    return { ok: false, reason: `Đăng nhập được nhưng chưa tải được dữ liệu — ${e.message || e}. Thử lại.` };
  }
  return { ok: true, userId: res.id, role: res.role, mustChangePassword: !!res.mustChangePassword, sbToken: res.token };
}

/** `strict`: TRUE khi gọi từ refresh() (1 phiên ĐANG có dữ liệu thật trong bộ nhớ — lỗi 1 bảng bất kỳ
 * cũng phải dừng hẳn, không ghi đè gì, xem giải thích PHÒNG VỆ bên dưới); FALSE (mặc định) khi gọi từ
 * login() (bộ nhớ đang RỖNG, không có gì để "ghi đè mất" — lỗi 1 bảng PHỤ (VD 1 mục "Bổ sung sau"
 * trong docs chưa setup đủ SQL/RLS trên project này) không nên chặn hẳn cả việc đăng nhập, chỉ cần
 * coi đúng bảng đó là rỗng và cảnh báo, các bảng khác vẫn tải bình thường).
 * `skipTables`: Set tên bảng ĐANG có thay đổi cục bộ chưa gửi lên (xem outbox trong refresh()) — CHỈ
 * đúng những bảng này mới giữ nguyên dữ liệu cục bộ, KHÔNG ghi đè bằng dữ liệu server (tránh mất thay
 * đổi chưa gửi lên); mọi bảng KHÁC (VD debtors/receivable_entries của "Người khác nợ tôi" — chưa bao
 * giờ ghi qua outbox này, luôn ghi qua Edge Function ở nơi khác) vẫn tải mới bình thường dù outbox
 * đang có gì đi nữa — đây là điểm khác biệt với bản trước (bỏ qua HẲN mọi bảng chỉ vì 1 bảng bất kỳ
 * có việc chờ). */
async function loadSessionData(token, { strict = false, skipTables = new Set() } = {}) {
  const sb = getSupabaseClient(token);
  const [
    userRes, catRes, txnRes, budgetRes, recRes, goalRes, planRes, creditorRes, debtEntryRes, debtorRes, receivableRes, notiRes, readRes,
  ] = await Promise.all([
    sb.from('user_profiles').select('*'),
    sb.from('categories').select('*').order('sort_order'),
    sb.from('transactions').select('*').order('txn_date', { ascending: false }),
    sb.from('budgets').select('*'),
    sb.from('recurring_transactions').select('*'),
    sb.from('savings_goals').select('*'),
    sb.from('plans').select('*'),
    sb.from('creditors').select('*'),
    sb.from('debt_entries').select('*').order('entry_date', { ascending: false }),
    sb.from('debtors').select('*'),
    sb.from('receivable_entries').select('*').order('entry_date', { ascending: false }),
    sb.from('notifications').select('*'),
    sb.from('notification_reads').select('notification_id'),
  ]);
  // PHÒNG VỆ chống "dữ liệu về 0": khi mất mạng/lỗi, thư viện Supabase KHÔNG ném lỗi (không làm
  // Promise.all() ở trên reject) — nó trả về BÌNH THƯỜNG với { data: null, error: {...} } cho MỌI câu
  // truy vấn bị lỗi (VD "Failed to fetch" lúc mất mạng, hoặc RLS âm thầm lọc rỗng nếu JWT không hợp
  // lệ/khớp) — coi như "thành công" ở mức Promise. Trước đây code chỉ lấy mỗi `data` (bỏ qua hẳn
  // `error`) rồi `data || []` -> null biến thành RỖNG và ghi đè thẳng vào state, đúng lúc mạng chập
  // chờn (dễ xảy ra nhất ngay khi vừa có mạng lại, hoặc khi đang mất mạng mà refresh() vẫn lỡ gọi tới
  // đây) là y hệt hiện tượng "dữ liệu về 0 như ban đầu" dù dữ liệu thật trên Supabase vẫn còn nguyên.
  const allResults = [userRes, catRes, txnRes, budgetRes, recRes, goalRes, planRes, creditorRes, debtEntryRes, debtorRes, receivableRes, notiRes, readRes];
  const firstErrorResult = allResults.find((r) => r.error);
  if (firstErrorResult) {
    const msg = `Lỗi tải 1 bảng dữ liệu: ${describeError(firstErrorResult.error)}`;
    if (strict) {
      // Đang refresh() 1 phiên CÓ SẴN dữ liệu thật -> không ghi đè gì cả, ném lỗi để refresh() giữ
      // nguyên dữ liệu cũ và tự thử lại sau (xem catch ở refresh()).
      throw new Error(`${msg} — đã bỏ qua, giữ nguyên dữ liệu cũ.`);
    }
    // Đăng nhập LẦN ĐẦU (bộ nhớ đang rỗng, không có gì để mất) -> đừng chặn hẳn đăng nhập chỉ vì 1
    // bảng PHỤ lỗi — coi đúng bảng đó là rỗng (đã có sẵn `|| []` bên dưới), các bảng khác vẫn tải
    // bình thường. Riêng categories thì canh KHÔNG tự tạo trùng bộ mặc định nếu chính bảng này lỗi
    // (xem check `!catRes.error` ở seedDefaultCategories bên dưới — categories trống OAN do lỗi tải
    // khác hẳn categories trống THẬT của 1 project mới toanh).
    console.warn(msg, firstErrorResult.error);
  }
  // user_profiles không có tên bảng trùng với outbox (outbox chỉ ghi 'transactions'/'creditors'/
  // 'debt_entries', xem tryWrite() ở khắp state.js) nên luôn an toàn tải mới — liệt kê tường minh ở
  // đây để rõ ràng bảng nào ứng với `skipTables` nào, tránh gõ nhầm tên bảng.
  if (!skipTables.has('transactions')) state.transactions = (txnRes.data || []).map(mapTransactionRow);
  if (!skipTables.has('creditors')) state.creditors = (creditorRes.data || []).map(mapCreditorRow);
  if (!skipTables.has('debt_entries')) state.debtEntries = (debtEntryRes.data || []).map(mapDebtEntryRow);
  state.users = (userRes.data || []).map(mapUserProfileRow);
  state.categories = (catRes.data || []).map(mapCategoryRow);
  state.budgets = (budgetRes.data || []).map(mapBudgetRow);
  state.recurring = (recRes.data || []).map(mapRecurringRow);
  state.savingsGoals = (goalRes.data || []).map(mapSavingsGoalRow);
  state.plans = (planRes.data || []).map(mapPlanRow);
  state.debtors = (debtorRes.data || []).map(mapDebtorRow);
  state.receivableEntries = (receivableRes.data || []).map(mapReceivableEntryRow);
  state.notifications = (notiRes.data || []).map(mapNotificationRow);
  state.notificationReads = (readRes.data || []).map((r) => r.notification_id);
  if (state.categories.length === 0 && !catRes.error) await seedDefaultCategories(sb);
  await ensureSpecialCategories(sb);
}

/** Lần đầu tiên chưa có danh mục nào (database Supabase mới toanh) -> tự tạo sẵn 1 bộ danh mục thường dùng + 2 danh mục hệ thống "Mượn nợ"/"Trả nợ", đỡ phải tự gõ từ đầu. */
async function seedDefaultCategories(sb) {
  const all = [...DEFAULT_CATEGORIES, ...SPECIAL_CATEGORIES];
  const rows = all.map((c, i) => ({
    id: genId('cat'), name: c.name, type: c.type, icon: c.icon, color: colorAt(i), sort_order: i, special: c.special || null,
  }));
  const { error } = await sb.from('categories').insert(rows);
  if (!error) state.categories = rows.map(mapCategoryRow);
}
/** Project ĐÃ có danh mục từ trước (tạo trước khi có tính năng Mượn/Trả nợ) -> tự bù thêm đúng 2
 * danh mục hệ thống còn thiếu. Nếu người dùng đã TỰ tạo sẵn 1 danh mục trùng tên/loại từ trước (VD
 * tự đặt "Mượn nợ" cho khoản thu) -> chỉ gắn thêm cờ `special` vào ĐÚNG danh mục đó, không tạo mới
 * trùng lặp — chỉ khi KHÔNG tìm thấy tên trùng mới tự tạo danh mục mới. Chạy mỗi lần đăng nhập, tự
 * bỏ qua nếu đã đủ — an toàn để gọi lặp lại nhiều lần. */
async function ensureSpecialCategories(sb) {
  const missing = SPECIAL_CATEGORIES.filter((sc) => !state.categories.some((c) => c.special === sc.special));
  for (const sc of missing) {
    const existing = state.categories.find((c) => c.type === sc.type && c.name.trim().toLowerCase() === sc.name.toLowerCase());
    if (existing) {
      const { error } = await sb.from('categories').update({ special: sc.special }).eq('id', existing.id);
      if (!error) existing.special = sc.special;
    } else {
      const row = {
        id: genId('cat'), name: sc.name, type: sc.type, icon: sc.icon,
        color: colorAt(state.categories.length), sort_order: state.categories.length, special: sc.special,
      };
      const { error } = await sb.from('categories').insert(row);
      if (!error) state.categories.push(mapCategoryRow(row));
    }
  }
}

function mapUserProfileRow(row) {
  return { id: row.id, name: row.name, role: row.role, createdAt: row.created_at };
}
function mapCategoryRow(row) {
  return {
    id: row.id, name: row.name, type: row.type, icon: row.icon || 'tag', color: row.color || '#2563eb',
    monthlyBudget: row.monthly_budget != null ? Number(row.monthly_budget) : null,
    sortOrder: row.sort_order || 0, active: row.active !== false, special: row.special || null,
  };
}
function mapTransactionRow(row) {
  return {
    id: row.id, type: row.type, amount: Number(row.amount), categoryId: row.category_id,
    note: row.note || '', date: row.txn_date, userId: row.user_id, recurringId: row.recurring_id,
    createdAt: row.created_at,
  };
}
function mapBudgetRow(row) {
  return { id: row.id, year: row.year, month: row.month, categoryId: row.category_id, amount: Number(row.amount) };
}
function mapRecurringRow(row) {
  return {
    id: row.id, type: row.type, amount: Number(row.amount), categoryId: row.category_id,
    note: row.note || '', dayOfMonth: row.day_of_month, active: row.active !== false, userId: row.user_id,
  };
}
function mapSavingsGoalRow(row) {
  return {
    id: row.id, name: row.name, targetAmount: Number(row.target_amount), currentAmount: Number(row.current_amount || 0),
    deadline: row.deadline, note: row.note || '', userId: row.user_id,
  };
}
function mapPlanRow(row) {
  return {
    id: row.id, type: row.type, amount: Number(row.amount), categoryId: row.category_id,
    title: row.title, dueDate: row.due_date, status: row.status,
    transactionId: row.transaction_id, userId: row.user_id, createdAt: row.created_at,
  };
}
function mapCreditorRow(row) {
  return {
    id: row.id, name: row.name, note: row.note || '', userId: row.user_id, createdAt: row.created_at,
    memberUserId: row.member_user_id || null, shared: !!row.shared, mirrorDebtorId: row.mirror_debtor_id || null,
  };
}
function mapDebtEntryRow(row) {
  return {
    id: row.id, creditorId: row.creditor_id, kind: row.kind, amount: Number(row.amount),
    date: row.entry_date, description: row.description || '',
    transactionId: row.transaction_id, userId: row.user_id, createdAt: row.created_at, shared: !!row.shared,
    mirrorEntryId: row.mirror_entry_id || null,
  };
}
function mapDebtorRow(row) {
  return {
    id: row.id, name: row.name, note: row.note || '', userId: row.user_id, createdAt: row.created_at,
    memberUserId: row.member_user_id || null, shared: !!row.shared,
  };
}
function mapReceivableEntryRow(row) {
  return {
    id: row.id, debtorId: row.debtor_id, kind: row.kind, amount: Number(row.amount),
    date: row.entry_date, description: row.description || '',
    transactionId: row.transaction_id, userId: row.user_id, createdAt: row.created_at, shared: !!row.shared,
  };
}
function mapNotificationRow(row) {
  return {
    id: row.id, fromUserId: row.from_user_id, toUserId: row.to_user_id,
    title: row.title, body: row.body || '', status: row.status,
    sendAt: row.send_at, createdAt: row.created_at, sentAt: row.sent_at,
  };
}

export async function verifyOwnPassword(password) {
  const session = getSession();
  if (!session) return false;
  const res = await callAccountFunction(session.sbToken, { type: 'verify-own-password', password });
  return !!(res.ok && res.valid);
}
export async function setOwnPassword(newPassword, opts = {}) {
  const session = getSession();
  const res = await callAccountFunction(session?.sbToken, { type: 'set-own-password', newPassword, mustChangePassword: !!opts.mustChangePassword });
  if (!res.ok) throw new Error(res.reason || 'Không đổi được mật khẩu.');
  setSession({ ...session, mustChangePassword: !!opts.mustChangePassword });
}
/** Tự đổi TÊN HIỂN THỊ của chính mình (owner hoặc member đều dùng được) — bảng `users` không cho
 * client ghi trực tiếp (xem docs/expense-app-setup.md mục 2) nên phải qua Edge Function. */
export async function setOwnName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Cần nhập tên hiển thị.');
  const session = getSession();
  const res = await callAccountFunction(session?.sbToken, { type: 'set-own-name', name: trimmed });
  if (!res.ok) throw new Error(res.reason || 'Không đổi được tên.');
  const u = getUser(session.id);
  if (u) u.name = trimmed;
  notify();
}

// ------------------------------------------------------------
// Thành viên (owner + member) — tạo/xóa/cấp lại mật khẩu qua Edge Function
// ------------------------------------------------------------
export function listMembers() { return state.users; }
export function getUser(id) { return state.users.find((u) => u.id === id); }
export function isOwner(id) { return getUser(id)?.role === 'owner'; }

export async function addMember({ username, name, password }) {
  const session = getSession();
  const res = await callAccountFunction(session?.sbToken, { type: 'member', username, name, password });
  if (!res.ok) throw new Error(res.reason || 'Không tạo được tài khoản.');
  state.users.push({ id: res.id, name: name || username, role: 'member', createdAt: new Date().toISOString() });
  notify();
  return { id: res.id, tempPassword: res.tempPassword };
}
export async function resetMemberPassword(userId, customPassword) {
  const session = getSession();
  const res = await callAccountFunction(session?.sbToken, { type: 'reset-member-password', userId, password: customPassword });
  if (!res.ok) throw new Error(res.reason || 'Không cấp lại được mật khẩu.');
  return res.tempPassword;
}
/** Owner đổi tên hiển thị của 1 tài khoản BẤT KỲ (kể cả chính owner) — khác setOwnName() ở trên là
 * hàm này KHÔNG cần đăng nhập bằng đúng tài khoản đó, chỉ cần đang là owner. */
export async function renameMember(userId, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Cần nhập tên hiển thị.');
  const session = getSession();
  const res = await callAccountFunction(session?.sbToken, { type: 'rename-member', userId, name: trimmed });
  if (!res.ok) throw new Error(res.reason || 'Không đổi được tên.');
  const u = getUser(userId);
  if (u) u.name = trimmed;
  notify();
}
export async function deleteMember(userId) {
  const session = getSession();
  const res = await callAccountFunction(session?.sbToken, { type: 'delete-member', userId });
  if (!res.ok) throw new Error(res.reason || 'Không xóa được tài khoản.');
  state.users = state.users.filter((u) => u.id !== userId);
  notify();
}

// ------------------------------------------------------------
// Danh mục — CRUD trực tiếp qua RLS (không nhạy cảm, không cần Edge Function)
// ------------------------------------------------------------
export function listCategories(filters = {}) {
  let list = state.categories.filter((c) => c.active);
  if (filters.type) list = list.filter((c) => c.type === filters.type);
  return list.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'vi'));
}
export function getCategory(id) { return state.categories.find((c) => c.id === id); }
/** Tìm danh mục hệ thống "Mượn nợ" (special='borrow') hoặc "Trả nợ" (special='repay') — dùng để tự
 * mở thêm ô Công nợ trong form Thêm giao dịch khi người dùng chọn đúng danh mục này. */
export function getCategoryBySpecial(special) { return state.categories.find((c) => c.special === special); }

export async function upsertCategory({ id, name, type, icon, color, monthlyBudget }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const row = {
    id: id || genId('cat'), name, type, icon: icon || 'tag', color: color || colorAt(state.categories.length),
    monthly_budget: monthlyBudget != null && monthlyBudget !== '' ? Number(monthlyBudget) : null,
    sort_order: id ? (getCategory(id)?.sortOrder ?? 0) : state.categories.length,
  };
  const { error } = await sb.from('categories').upsert(row, { onConflict: 'id' });
  if (error) throw new Error('Không lưu được danh mục, thử lại sau.');
  const idx = state.categories.findIndex((c) => c.id === row.id);
  const mapped = mapCategoryRow({ ...row, active: true });
  if (idx >= 0) state.categories[idx] = mapped; else state.categories.push(mapped);
  notify();
  return mapped;
}
/** Xóa danh mục — giao dịch/định kỳ cũ dùng danh mục này KHÔNG bị xóa theo, chỉ mất liên kết (hiện "Không rõ danh mục"). */
export async function deleteCategory(id) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const { error } = await sb.from('categories').delete().eq('id', id);
  if (error) throw new Error('Không xóa được danh mục, thử lại sau.');
  state.categories = state.categories.filter((c) => c.id !== id);
  state.budgets = state.budgets.filter((b) => b.categoryId !== id);
  notify();
}
/** Đổi thứ tự hiển thị 1 danh mục — hoán đổi sort_order với danh mục liền kề CÙNG loại (thu/chi riêng). direction: 'up' | 'down'. */
export async function moveCategory(id, direction) {
  const cat = getCategory(id);
  if (!cat) return;
  const siblings = listCategories({ type: cat.type });
  const idx = siblings.findIndex((c) => c.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) return;
  const other = siblings[swapIdx];
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const [{ error: err1 }, { error: err2 }] = await Promise.all([
    sb.from('categories').update({ sort_order: other.sortOrder }).eq('id', cat.id),
    sb.from('categories').update({ sort_order: cat.sortOrder }).eq('id', other.id),
  ]);
  if (err1 || err2) throw new Error('Không đổi được thứ tự, thử lại sau.');
  const tmp = cat.sortOrder; cat.sortOrder = other.sortOrder; other.sortOrder = tmp;
  notify();
}

// ------------------------------------------------------------
// Giao dịch (thu/chi)
// ------------------------------------------------------------
export function listTransactions(filters = {}) {
  let list = state.transactions;
  if (filters.type) list = list.filter((t) => t.type === filters.type);
  if (filters.categoryId) list = list.filter((t) => t.categoryId === filters.categoryId);
  if (filters.userId) list = list.filter((t) => t.userId === filters.userId);
  if (filters.from) list = list.filter((t) => t.date >= filters.from);
  if (filters.to) list = list.filter((t) => t.date <= filters.to);
  if (filters.q) {
    const q = filters.q.trim().toLowerCase();
    if (q) list = list.filter((t) => (t.note || '').toLowerCase().includes(q) || (getCategory(t.categoryId)?.name || '').toLowerCase().includes(q));
  }
  return list.slice().sort((a, b) => (b.date).localeCompare(a.date) || new Date(b.createdAt) - new Date(a.createdAt));
}
export function getTransaction(id) { return state.transactions.find((t) => t.id === id); }

export async function addTransaction({ type, amount, categoryId, note, date, recurringId }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const createdAt = new Date().toISOString(); // ghi sẵn NGAY LÚC NÀY — dù lát nữa mới đồng bộ được
  // (mất mạng) thì thời điểm hiển thị vẫn đúng lúc thao tác thật, không phải lúc có mạng lại.
  const row = {
    id: genId('txn'), type, amount: Number(amount) || 0, category_id: categoryId || null,
    note: note || '', txn_date: date || new Date().toISOString().slice(0, 10),
    user_id: session.id, recurring_id: recurringId || null, created_at: createdAt,
  };
  const { error } = await tryWrite(sb, 'transactions', 'insert', row);
  if (error) throw new Error('Không lưu được giao dịch, thử lại sau.');
  state.transactions.unshift(mapTransactionRow(row));
  notify();
}
/** Tìm dòng Công nợ (sổ nợ/sổ cho vay) ĐI KÈM 1 giao dịch cụ thể (tạo từ ô Mượn nợ/Trả nợ ở form
 * Thêm giao dịch, hoặc tick "đưa vào thu/chi" ở trang Công nợ) — dùng để đồng bộ 2 chiều: sửa/xóa
 * giao dịch ở trang Giao dịch (bình thường) thì dòng Công nợ đi kèm cũng phải sửa/xóa theo, không
 * để lại dòng "mồ côi" trỏ tới giao dịch không còn tồn tại. */
function findLinkedDebtOrReceivableEntry(transactionId) {
  const debtEntry = state.debtEntries.find((e) => e.transactionId === transactionId);
  if (debtEntry) return { type: 'debt', entry: debtEntry, counterpart: getCreditor(debtEntry.creditorId) };
  const recvEntry = state.receivableEntries.find((e) => e.transactionId === transactionId);
  if (recvEntry) return { type: 'receivable', entry: recvEntry, counterpart: getDebtor(recvEntry.debtorId) };
  return null;
}
export async function updateTransaction(id, { type, amount, categoryId, note, date }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const newAmount = Number(amount) || 0;
  const linked = findLinkedDebtOrReceivableEntry(id);
  // Giao dịch này có kèm 1 dòng Công nợ (Mượn nợ/Trả nợ, hoặc Cho vay/Thu tiền có tích "đưa vào thu/
  // chi") -> dòng "GIẢM nợ" (trả nợ/thu tiền) sửa số tiền ở đây vẫn KHÔNG được vượt quá nợ còn lại —
  // cộng lại đúng số tiền CŨ của dòng này vào nợ còn lại trước khi so sánh (giống updateDebtEntry).
  if (linked && (linked.entry.kind === 'payment' || linked.entry.kind === 'collect')) {
    const balance = linked.type === 'debt' ? creditorBalance(linked.entry.creditorId) : debtorBalance(linked.entry.debtorId);
    const maxAmount = balance + linked.entry.amount;
    if (newAmount > maxAmount) throw new Error(`Số tiền không được vượt quá ${formatVND(maxAmount)} (nợ còn lại).`);
  }
  const patch = { type, amount: newAmount, category_id: categoryId || null, note: note || '', txn_date: date };
  const { error } = await tryWrite(sb, 'transactions', 'update', patch, { column: 'id', value: id });
  if (error) throw new Error('Không cập nhật được giao dịch, thử lại sau.');
  const t = getTransaction(id);
  if (t) Object.assign(t, { type, amount: newAmount, categoryId: categoryId || null, note: note || '', date });

  if (linked) {
    const table = linked.type === 'debt' ? 'debt_entries' : 'receivable_entries';
    const { error: entryErr } = await tryWrite(sb, table, 'update', { amount: newAmount, entry_date: date }, { column: 'id', value: linked.entry.id });
    if (entryErr) throw new Error('Đã cập nhật giao dịch nhưng chưa đồng bộ được vào Công nợ, thử lại sau.');
    linked.entry.amount = newAmount;
    linked.entry.date = date;
    if (linked.type === 'debt') {
      // Cùng logic như updateDebtEntry() — sửa giao dịch (thay vì sửa trực tiếp ở trang Công nợ)
      // nhưng dòng Công nợ đi kèm vẫn cần đồng bộ mirror y hệt.
      const pendingAddIdx = Array.isArray(state.pendingMirrors) ? state.pendingMirrors.findIndex((j) => j.op === 'add' && j.entryId === linked.entry.id) : -1;
      if (pendingAddIdx > -1) {
        state.pendingMirrors[pendingAddIdx].amount = newAmount;
        state.pendingMirrors[pendingAddIdx].date = date;
        persist();
      } else if (linked.entry.mirrorEntryId) {
        queueAndKickMirror({ op: 'update', entryId: linked.entry.id, mirrorEntryId: linked.entry.mirrorEntryId, amount: newAmount, date, debtKind: linked.entry.kind });
      }
    }
  }
  notify();
}
export async function deleteTransaction(id) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  // Xóa dòng Công nợ đi kèm TRƯỚC (nếu có) -> chỉ xóa giao dịch nếu bước này thành công, tránh để
  // lại dòng Công nợ mồ côi khi thao tác nửa chừng bị lỗi mạng.
  const linked = findLinkedDebtOrReceivableEntry(id);
  if (linked) {
    const table = linked.type === 'debt' ? 'debt_entries' : 'receivable_entries';
    const { error: linkErr } = await tryWrite(sb, table, 'delete', null, { column: 'id', value: linked.entry.id });
    if (linkErr) throw new Error('Không xóa được dòng Công nợ liên kết, thử lại sau.');
    if (linked.type === 'debt') {
      state.debtEntries = state.debtEntries.filter((e) => e.id !== linked.entry.id);
      // Cùng logic như deleteDebtEntry() — xóa giao dịch (thay vì xóa trực tiếp ở trang Công nợ)
      // nhưng dòng Công nợ đi kèm vẫn bị xóa theo, nên mirror cũng cần hủy/xóa y hệt.
      if (Array.isArray(state.pendingMirrors) && state.pendingMirrors.length) {
        const before = state.pendingMirrors.length;
        state.pendingMirrors = state.pendingMirrors.filter((j) => j.entryId !== linked.entry.id);
        if (state.pendingMirrors.length !== before) persist();
      }
      if (linked.entry.mirrorEntryId) {
        queueAndKickMirror({ op: 'delete', entryId: linked.entry.id, mirrorEntryId: linked.entry.mirrorEntryId });
      }
    } else {
      state.receivableEntries = state.receivableEntries.filter((e) => e.id !== linked.entry.id);
    }
  }
  const { error } = await tryWrite(sb, 'transactions', 'delete', null, { column: 'id', value: id });
  if (error) throw new Error('Không xóa được giao dịch, thử lại sau.');
  state.transactions = state.transactions.filter((t) => t.id !== id);
  notify();
}

// ------------------------------------------------------------
// Nhật ký hoạt động (Thêm/Sửa/Xóa giao dịch) — CHỈ chủ sổ xem được (RLS), phục vụ rà soát của
// Trưởng ban kiểm soát. Ghi bằng TRIGGER ở chính Supabase (không phải code JS gọi tay từng chỗ) —
// tự bắt được MỌI đường tạo/sửa/xóa transactions hiện có lẫn thêm sau này (Thêm giao dịch, Mượn/
// Trả nợ, Xác nhận định kỳ, Hoàn thành kế hoạch...), khỏi lo code bỏ sót chỗ nào. Xem
// docs/expense-app-setup.md mục 14. KHÔNG cache trong `state` chính (chỉ chủ sổ cần, hiếm khi vào)
// — tải trực tiếp mỗi lần vào trang Nhật ký.
// ------------------------------------------------------------
function mapActivityLogRow(row) {
  return {
    id: row.id, action: row.action, txnId: row.txn_id, userId: row.user_id, userName: row.user_name || 'Không rõ',
    txnType: row.txn_type, txnAmount: Number(row.txn_amount) || 0, txnCategoryName: row.txn_category_name || '',
    txnNote: row.txn_note || '', txnDate: row.txn_date, createdAt: row.created_at,
  };
}
export async function fetchActivityLog(limit = 200) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const { data, error } = await sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error('Không tải được nhật ký, thử lại sau.');
  return (data || []).map(mapActivityLogRow);
}

// ------------------------------------------------------------
// Tính toán theo tháng — dashboard, ngân sách, báo cáo dùng chung
// ------------------------------------------------------------
export function monthKey(year, month) { return `${year}-${String(month).padStart(2, '0')}`; }
export function monthRange(year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to, lastDay };
}
export function totalsForMonth(year, month) {
  const { from, to } = monthRange(year, month);
  const list = state.transactions.filter((t) => t.date >= from && t.date <= to);
  const income = list.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = list.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  return { income, expense, balance: income - expense };
}
/** Tổng chi theo từng danh mục trong tháng — Map<categoryId, số tiền>. */
export function expenseByCategoryForMonth(year, month) {
  const { from, to } = monthRange(year, month);
  const map = new Map();
  for (const t of state.transactions) {
    if (t.type !== 'expense' || t.date < from || t.date > to) continue;
    map.set(t.categoryId, (map.get(t.categoryId) || 0) + t.amount);
  }
  return map;
}
/** Dự báo tổng chi cuối tháng dựa trên tốc độ chi tiêu hiện tại (chỉ có ý nghĩa với tháng hiện tại). */
/**
 * Công thức: (tổng đã chi từ đầu tháng đến hôm nay ÷ số ngày đã qua) × tổng
 * số ngày trong tháng — suy ra tốc độ chi trung bình mỗi ngày rồi nhân lên
 * cho cả tháng. Trả về null nếu mới đầu tháng (dưới 3 ngày dữ liệu): quá ít
 * dữ liệu khiến con số dễ lệch rất xa thực tế (vd: mới trả 1 khoản lớn như
 * tiền nhà ngay ngày 1-2 sẽ bị nhân lên thành số khổng lồ sai lệch).
 */
export function forecastExpense(year, month, asOf = new Date()) {
  const { lastDay } = monthRange(year, month);
  const dayOfMonth = Math.min(asOf.getDate(), lastDay);
  const { expense } = totalsForMonth(year, month);
  if (dayOfMonth < 3) return null;
  return Math.round((expense / dayOfMonth) * lastDay);
}
/** Tổng thu/chi 6 tháng gần nhất (tính cả tháng hiện tại) — mới nhất ở cuối mảng, dùng cho biểu đồ xu hướng. */
export function last6MonthsTotals(asOf = new Date()) {
  const result = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(asOf.getFullYear(), asOf.getMonth() - i, 1);
    const y = d.getFullYear(), m = d.getMonth() + 1;
    result.push({ year: y, month: m, ...totalsForMonth(y, m) });
  }
  return result;
}

// ------------------------------------------------------------
// Ngân sách hàng tháng theo danh mục
// ------------------------------------------------------------
/** Hạn mức ĐANG ÁP DỤNG cho 1 danh mục trong tháng: ưu tiên số đã đặt riêng cho tháng đó, không có thì lấy mặc định của danh mục (có thể null = chưa đặt hạn mức). */
export function effectiveBudget(categoryId, year, month) {
  const override = state.budgets.find((b) => b.categoryId === categoryId && b.year === year && b.month === month);
  if (override) return override.amount;
  return getCategory(categoryId)?.monthlyBudget ?? null;
}
/** Danh sách đầy đủ: mỗi danh mục chi tiêu + hạn mức đang áp dụng + đã chi trong tháng + % đã dùng. */
export function budgetOverviewForMonth(year, month) {
  const spentMap = expenseByCategoryForMonth(year, month);
  return listCategories({ type: 'expense' }).map((cat) => {
    const limit = effectiveBudget(cat.id, year, month);
    const spent = spentMap.get(cat.id) || 0;
    return { category: cat, limit, spent, percent: limit ? Math.round((spent / limit) * 100) : null, over: limit != null && spent > limit };
  });
}

// ------------------------------------------------------------
// Giao dịch định kỳ (tiền điện, lương, thuê nhà...) — tự nhắc, không tự ý ghi sổ
// ------------------------------------------------------------
export function listRecurring() { return state.recurring.filter((r) => r.active); }
export async function addRecurring({ type, amount, categoryId, note, dayOfMonth }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const row = {
    id: genId('rec'), type, amount: Number(amount) || 0, category_id: categoryId || null,
    note: note || '', day_of_month: Number(dayOfMonth) || 1, active: true, user_id: session.id,
  };
  const { error } = await sb.from('recurring_transactions').insert(row);
  if (error) throw new Error('Không lưu được khoản định kỳ, thử lại sau.');
  state.recurring.push(mapRecurringRow(row));
  notify();
}
export async function updateRecurring(id, { type, amount, categoryId, note, dayOfMonth, active }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const patch = { type, amount: Number(amount) || 0, category_id: categoryId || null, note: note || '', day_of_month: Number(dayOfMonth) || 1, active: active !== false };
  const { error } = await sb.from('recurring_transactions').update(patch).eq('id', id);
  if (error) throw new Error('Không cập nhật được, thử lại sau.');
  const r = state.recurring.find((x) => x.id === id);
  if (r) Object.assign(r, { type, amount: patch.amount, categoryId: patch.category_id, note: patch.note, dayOfMonth: patch.day_of_month, active: patch.active });
  notify();
}
export async function deleteRecurring(id) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const { error } = await sb.from('recurring_transactions').delete().eq('id', id);
  if (error) throw new Error('Không xóa được, thử lại sau.');
  state.recurring = state.recurring.filter((r) => r.id !== id);
  notify();
}
/** Các khoản định kỳ đã tới/qua ngày trong THÁNG HIỆN TẠI mà chưa có giao dịch nào ghi từ nó -> cần nhắc. */
export function pendingRecurringReminders(asOf = new Date()) {
  const year = asOf.getFullYear(), month = asOf.getMonth() + 1;
  const { from, to } = monthRange(year, month);
  const loggedRecurringIds = new Set(state.transactions.filter((t) => t.date >= from && t.date <= to && t.recurringId).map((t) => t.recurringId));
  return listRecurring().filter((r) => asOf.getDate() >= r.dayOfMonth && !loggedRecurringIds.has(r.id));
}
/** Xác nhận 1 khoản định kỳ -> tự tạo giao dịch tương ứng cho tháng hiện tại (có thể sửa số tiền lúc xác nhận nếu tháng này khác thường). */
export async function confirmRecurring(recurringId, { amount, date } = {}) {
  const r = state.recurring.find((x) => x.id === recurringId);
  if (!r) throw new Error('Không tìm thấy khoản định kỳ.');
  await addTransaction({
    type: r.type, amount: amount != null ? amount : r.amount, categoryId: r.categoryId,
    note: r.note || 'Định kỳ', date: date || new Date().toISOString().slice(0, 10), recurringId: r.id,
  });
}

// ------------------------------------------------------------
// Mục tiêu tiết kiệm
// ------------------------------------------------------------
export function listSavingsGoals() { return state.savingsGoals; }
export async function addSavingsGoal({ name, targetAmount, deadline, note }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const row = { id: genId('goal'), name, target_amount: Number(targetAmount) || 0, current_amount: 0, deadline: deadline || null, note: note || '', user_id: session.id };
  const { error } = await sb.from('savings_goals').insert(row);
  if (error) throw new Error('Không tạo được mục tiêu, thử lại sau.');
  state.savingsGoals.push(mapSavingsGoalRow(row));
  notify();
}
export async function updateSavingsGoal(id, { name, targetAmount, deadline, note }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const patch = { name, target_amount: Number(targetAmount) || 0, deadline: deadline || null, note: note || '' };
  const { error } = await sb.from('savings_goals').update(patch).eq('id', id);
  if (error) throw new Error('Không cập nhật được, thử lại sau.');
  const g = state.savingsGoals.find((x) => x.id === id);
  if (g) Object.assign(g, { name, targetAmount: patch.target_amount, deadline: patch.deadline, note: patch.note });
  notify();
}
/** Góp thêm (hoặc rút bớt nếu truyền số âm) vào 1 mục tiêu tiết kiệm. */
export async function contributeSavingsGoal(id, amount) {
  const g = state.savingsGoals.find((x) => x.id === id);
  if (!g) throw new Error('Không tìm thấy mục tiêu.');
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const newAmount = Math.max(0, g.currentAmount + Number(amount));
  const { error } = await sb.from('savings_goals').update({ current_amount: newAmount }).eq('id', id);
  if (error) throw new Error('Không cập nhật được, thử lại sau.');
  g.currentAmount = newAmount;
  notify();
}
export async function deleteSavingsGoal(id) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const { error } = await sb.from('savings_goals').delete().eq('id', id);
  if (error) throw new Error('Không xóa được, thử lại sau.');
  state.savingsGoals = state.savingsGoals.filter((g) => g.id !== id);
  notify();
}

// ------------------------------------------------------------
// Kế hoạch chi tiêu — khoản thu/chi DỰ ĐỊNH (vd "cuối tháng mua sắm 2
// triệu"): chỉ để nhắc/theo dõi, KHÔNG tính vào tổng thu/chi thật cho tới
// khi tick "Hoàn thành" — lúc đó completePlan() mới tự tạo 1 giao dịch thật
// (transactions) và đánh dấu kế hoạch xong, liên kết qua transactionId.
// ------------------------------------------------------------
export function listPlans(filters = {}) {
  let list = state.plans;
  if (filters.status) list = list.filter((p) => p.status === filters.status);
  return list.slice().sort((a, b) => (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99'));
}
export function getPlan(id) { return state.plans.find((p) => p.id === id); }
/** Kế hoạch chưa hoàn thành đã có ngày dự định, sắp tới (trong `days` ngày) hoặc đã quá hạn — dùng cho thông báo trên Tổng quan. */
export function upcomingPlans(asOf = new Date(), days = 7) {
  const todayStr = asOf.toISOString().slice(0, 10);
  const limitStr = addDaysISO(todayStr, days);
  return listPlans({ status: 'pending' }).filter((p) => p.dueDate && p.dueDate <= limitStr);
}
function addDaysISO(iso, n) {
  const dt = new Date(iso);
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().slice(0, 10);
}

export async function addPlan({ type, amount, categoryId, title, dueDate }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const row = {
    id: genId('plan'), type, amount: Number(amount) || 0, category_id: categoryId || null,
    title, due_date: dueDate || null, status: 'pending', user_id: session.id,
  };
  const { error } = await sb.from('plans').insert(row);
  if (error) throw new Error('Không lưu được kế hoạch, thử lại sau.');
  state.plans.push(mapPlanRow({ ...row, created_at: new Date().toISOString() }));
  notify();
}
export async function updatePlan(id, { type, amount, categoryId, title, dueDate }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const patch = { type, amount: Number(amount) || 0, category_id: categoryId || null, title, due_date: dueDate || null };
  const { error } = await sb.from('plans').update(patch).eq('id', id);
  if (error) throw new Error('Không cập nhật được, thử lại sau.');
  const p = getPlan(id);
  if (p) Object.assign(p, { type, amount: patch.amount, categoryId: patch.category_id, title, dueDate: patch.due_date });
  notify();
}
export async function deletePlan(id) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const { error } = await sb.from('plans').delete().eq('id', id);
  if (error) throw new Error('Không xóa được, thử lại sau.');
  state.plans = state.plans.filter((p) => p.id !== id);
  notify();
}
/** Tick "Hoàn thành" — tự tạo giao dịch thật (thu hoặc chi) rồi mới đánh dấu kế hoạch xong, liên kết 2 bên qua transactionId. Có thể sửa lại số tiền/ngày lúc xác nhận nếu khác dự tính ban đầu. */
export async function completePlan(id, { amount, date } = {}) {
  const p = getPlan(id);
  if (!p) throw new Error('Không tìm thấy kế hoạch.');
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const finalAmount = amount != null ? Number(amount) || 0 : p.amount;
  const finalDate = date || new Date().toISOString().slice(0, 10);
  const txnRow = {
    id: genId('txn'), type: p.type, amount: finalAmount, category_id: p.categoryId,
    note: p.title, txn_date: finalDate, user_id: session.id, recurring_id: null,
  };
  const { error: txnErr } = await sb.from('transactions').insert(txnRow);
  if (txnErr) throw new Error('Không tạo được giao dịch, thử lại sau.');
  const { error: planErr } = await sb.from('plans').update({ status: 'done', transaction_id: txnRow.id }).eq('id', id);
  if (planErr) throw new Error('Đã tạo giao dịch nhưng chưa cập nhật được trạng thái kế hoạch, thử lại sau.');
  state.transactions.unshift(mapTransactionRow({ ...txnRow, created_at: new Date().toISOString() }));
  p.status = 'done';
  p.transactionId = txnRow.id;
  notify();
}

// ------------------------------------------------------------
// Quản lý nợ theo TỪNG CHỦ NỢ (vd "Tạp hóa A", "Anh Ba") — mỗi chủ nợ có 1
// sổ riêng (debtEntries) gồm 2 loại dòng: "charge" (ghi nợ thêm — mua gì,
// ngày nào, nợ bao nhiêu) và "payment" (trả nợ — ngày nào, trả bao nhiêu).
// Còn nợ = tổng charge - tổng payment, tính ngay lúc đọc (không lưu cột
// riêng để khỏi lệch). MẶC ĐỊNH ghi nợ/trả nợ đều KHÔNG đụng tới thu/chi
// thật — chỉ khi người dùng tự TÍCH CHỌN "đưa vào thu/chi" lúc ghi/sửa mới
// tự tạo (hoặc đồng bộ) 1 giao dịch thật, liên kết qua transactionId. Ghi
// nợ (vay/mua chịu) = tiền/hàng VỀ TAY mình -> giao dịch THU; trả nợ = tiền
// THẬT SỰ rời túi -> giao dịch CHI (ngược pha nhau). Riêng tư từng người
// dùng (RLS lọc theo user_id), KHÔNG hiện trên Tổng quan.
// ------------------------------------------------------------
function entriesOf(creditorId) { return state.debtEntries.filter((e) => e.creditorId === creditorId); }
/** Còn nợ của 1 chủ nợ = tổng ghi nợ - tổng đã trả. */
export function creditorBalance(creditorId) {
  return entriesOf(creditorId).reduce((s, e) => s + (e.kind === 'charge' ? e.amount : -e.amount), 0);
}
/** Danh sách chủ nợ kèm số dư còn nợ + ngày hoạt động gần nhất, mới nhất trước.
 * filters.status: 'active' (còn nợ) | 'paid' (đã trả hết).
 * filters.shared: false/bỏ qua = CHỈ sổ riêng tư của mình (mặc định, giữ đúng hành vi cũ); true =
 * CHỈ sổ "Nợ chung" (mọi thành viên cùng xem/sửa) — 2 loại không bao giờ trộn chung 1 danh sách. */
export function listCreditors(filters = {}) {
  let list = state.creditors.filter((c) => !!c.shared === !!filters.shared).map((c) => {
    const entries = entriesOf(c.id);
    const lastDate = entries.reduce((m, e) => (e.date > m ? e.date : m), '');
    return { ...c, balance: creditorBalance(c.id), lastDate, entryCount: entries.length };
  });
  if (filters.status === 'active') list = list.filter((c) => c.balance > 0);
  else if (filters.status === 'paid') list = list.filter((c) => c.balance <= 0 && c.entryCount > 0);
  return list.sort((a, b) => b.lastDate.localeCompare(a.lastDate) || a.name.localeCompare(b.name));
}
export function getCreditor(id) { return state.creditors.find((c) => c.id === id); }
/** Toàn bộ TÊN chủ nợ đã dùng qua, không trùng (kể cả đã "đã trả hết") — để gợi ý lúc ghi nợ mới, hoạt động gần nhất trước. */
export function listCreditorNames(shared = false) {
  const seen = new Set();
  const names = [];
  listCreditors({ shared }).forEach((c) => {
    const key = c.name.trim().toLowerCase();
    if (!seen.has(key)) { seen.add(key); names.push(c.name); }
  });
  return names;
}
/** Sổ nợ của 1 chủ nợ (ghi nợ + trả nợ), mới nhất trước. */
export function listDebtEntries(creditorId) {
  return entriesOf(creditorId).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}
/** Tổng còn nợ RIÊNG TƯ của mình (không tính "Nợ chung" — xem totalSharedDebtRemaining). */
export function totalDebtRemaining() {
  return state.creditors.filter((c) => !c.shared).reduce((s, c) => s + Math.max(0, creditorBalance(c.id)), 0);
}
/** Tổng còn nợ của "Nợ chung" (quỹ chung, mọi thành viên cùng thấy con số này). */
export function totalSharedDebtRemaining() {
  return state.creditors.filter((c) => c.shared).reduce((s, c) => s + Math.max(0, creditorBalance(c.id)), 0);
}

/** Chỉ tìm chủ nợ CÒN ĐANG NỢ (balance > 0) trong ĐÚNG 1 sổ (riêng tư hoặc Nợ chung, không lẫn
 * nhau) — ưu tiên khớp theo `memberUserId` (chủ nợ là 1 thành viên cụ thể trong sổ) nếu có truyền,
 * không thì khớp theo tên. Chủ nợ đã "đã trả hết" không tính, để lần ghi nợ mới cùng tên/thành viên
 * KHÔNG bị chồng vào sổ cũ đã đóng, mà tự mở 1 sổ nợ mới. */
function findOpenCreditorByName(name, { shared = false, memberUserId = null } = {}) {
  const pool = state.creditors.filter((c) => !!c.shared === !!shared && creditorBalance(c.id) > 0);
  // Chủ nợ là 1 THÀNH VIÊN cụ thể -> CHỈ khớp theo memberUserId, không rơi xuống so tên nữa — tránh
  // trường hợp trước đó lỡ gõ tay 1 chủ nợ "người ngoài" TRÙNG TÊN với thành viên này (vd tự gõ tên
  // thành viên ở tab "Người ngoài") rồi bị nhận nhầm là đúng sổ của thành viên, khiến khoản mượn mới
  // không được đánh dấu `memberUserId` -> không tự điền hộ sang sổ riêng của họ được (performMirrorAdd
  // không được gọi vì tưởng đây là chủ nợ ngoài, không phải lỗi Edge Function/SQL gì cả).
  if (memberUserId) return pool.find((c) => c.memberUserId === memberUserId) || null;
  const key = (name || '').trim().toLowerCase();
  return pool.find((c) => !c.memberUserId && c.name.trim().toLowerCase() === key) || null;
}
async function ensureCreditor(name, sb, session, { shared = false, memberUserId = null } = {}) {
  const existing = findOpenCreditorByName(name, { shared, memberUserId });
  if (existing) return existing;
  const row = {
    id: genId('creditor'), name: name.trim(), note: '', user_id: session.id, shared, member_user_id: memberUserId || null,
    created_at: new Date().toISOString(),
  };
  const { error } = await tryWrite(sb, 'creditors', 'insert', row);
  if (error) throw new Error('Không tạo được chủ nợ, thử lại sau.');
  const c = mapCreditorRow(row);
  state.creditors.push(c);
  return c;
}
// Khoản Nợ chung là của CẢ NHÀ, không thuộc về riêng ai — dòng mirror bên sổ riêng "Người khác nợ
// tôi" của thành viên vì vậy LUÔN đứng tên "Quỹ chung mượn" (không phải tên người vừa thao tác, vì
// người ghi hộ giao dịch không nhất thiết là người thật sự "mượn"), và mô tả cố định theo đúng
// chiều tăng/giảm nợ — không dùng mô tả tự do người dùng gõ ở Nợ chung (có thể trống/không phù hợp
// khi hiện sang sổ của người khác).
const MIRROR_DEBTOR_NAME = 'Quỹ chung mượn';
function mirrorEntryDescription(debtEntryKind) {
  return debtEntryKind === 'charge' ? 'Quỹ mượn nợ' : 'Quỹ trả nợ';
}
/** Mượn nợ 1 THÀNH VIÊN trong sổ (memberUserId) -> tự "điền hộ" luôn vào sổ "Người khác nợ tôi"
 * RIÊNG TƯ của đúng thành viên đó, khỏi phải tự gõ tay lại 2 lần — kể cả khi thành viên đó CHÍNH LÀ
 * người đang đăng nhập (không loại trừ bản thân), vì "use" trong danh sách chọn luôn có cả chính
 * mình (xem borrowFieldsHtml() ở txnForm.js). Trả nợ cho chủ nợ là 1 thành viên (memberUserId đã có
 * mirrorDebtorId từ lần mượn trước) cũng tự thêm dòng "collect" tương ứng để trừ nợ bên sổ riêng
 * của họ luôn — 2 sổ (Nợ chung + sổ riêng của thành viên) LUÔN khớp nhau, không cần nhập tay từng
 * cái. Ghi vào bảng RIÊNG TƯ của NGƯỜI KHÁC (hoặc CHÍNH MÌNH) nên RLS chặn viết trực tiếp — phải
 * nhờ Edge Function (service_role) làm hộ, xem type 'debt-mirror-add' ở
 * supabase/functions/create-account/index.ts. LUÔN "best effort": mirror lỗi chỉ console.warn, sổ
 * Nợ chung (nguồn dữ liệu chính) vẫn đúng dù mirror thất bại. `debtKind` là kind bên debt_entries
 * ('charge'/'payment') — tự suy ra kind bên receivable_entries ('lend'/'collect') + mô tả cố định. */
// Cả 3 hàm performMirror* dưới đây đều trả về { status: 'ok' | 'network' | 'error', reason? }:
// 'network' = lỗi rõ do MẤT MẠNG (server không trả lời được) -> nơi gọi tự xếp vào state.pendingMirrors
// để processPendingMirrors() làm hộ khi có mạng lại; 'error' = server đã trả lời nhưng từ chối (lỗi
// THẬT, VD thiếu cột mirror_*_id vì chưa chạy đủ SQL) -> best-effort, chỉ console.warn rồi bỏ qua
// (Nợ chung vẫn đúng, không nên giữ mãi trong hàng đợi để lặp lại 1 lỗi sẽ KHÔNG BAO GIỜ tự hết).
async function performMirrorAdd(creditor, entry, { debtKind, amount, date, sbToken }) {
  const res = await callAccountFunction(sbToken, {
    type: 'debt-mirror-add', memberUserId: creditor.memberUserId, debtorId: creditor.mirrorDebtorId,
    name: MIRROR_DEBTOR_NAME, kind: debtKind === 'charge' ? 'lend' : 'collect', amount, date,
    description: mirrorEntryDescription(debtKind),
  });
  if (!res.ok) {
    if (res.networkError) return { status: 'network' };
    console.warn('performMirrorAdd không thành công:', res.reason);
    return { status: 'error', reason: res.reason };
  }
  // LƯU LẠI con trỏ tới dòng mirror vừa tạo (mirror_debtor_id/mirror_entry_id) — nếu 2 lệnh update
  // này lỗi (VD chưa chạy SQL mục 13.1 thêm cột) thì lần sau tải lại trang (đăng nhập lại/refresh) sẽ
  // KHÔNG còn biết dòng mirror này ở đâu để đồng bộ sửa/xóa theo nữa (dòng mirror thành "mồ côi", vẫn
  // tồn tại nhưng mất liên kết) -> phải coi đây là lỗi để báo rõ, không chỉ im lặng cập nhật bộ nhớ.
  const sb = getSupabaseClient(sbToken);
  let linkOk = true;
  if (!creditor.mirrorDebtorId) {
    const { error: linkErr } = await sb.from('creditors').update({ mirror_debtor_id: res.debtorId }).eq('id', creditor.id);
    if (linkErr) { console.warn('performMirrorAdd: không lưu được mirror_debtor_id (thiếu cột? xem docs mục 13.1):', linkErr.message); linkOk = false; }
    else creditor.mirrorDebtorId = res.debtorId;
  }
  const { error: entryLinkErr } = await sb.from('debt_entries').update({ mirror_entry_id: res.entryId }).eq('id', entry.id);
  if (entryLinkErr) { console.warn('performMirrorAdd: không lưu được mirror_entry_id (thiếu cột? xem docs mục 13.1):', entryLinkErr.message); linkOk = false; }
  else entry.mirrorEntryId = res.entryId;
  return linkOk ? { status: 'ok' } : { status: 'error' };
}
/** Đồng bộ số tiền/ngày sang đúng dòng mirror (xem performMirrorAdd) khi sửa lại dòng gốc bên Nợ
 * chung — mô tả LUÔN giữ cố định theo mirrorEntryDescription(), không đồng bộ mô tả tự do người dùng gõ. */
async function performMirrorUpdate(mirrorEntryId, { amount, date, debtKind, sbToken }) {
  const res = await callAccountFunction(sbToken, { type: 'debt-mirror-update', entryId: mirrorEntryId, amount, date, description: mirrorEntryDescription(debtKind) });
  if (!res.ok) { if (!res.networkError) console.warn('performMirrorUpdate không thành công:', res.reason); return { status: res.networkError ? 'network' : 'error' }; }
  return { status: 'ok' };
}
/** Xóa dòng mirror (xem performMirrorAdd) khi dòng gốc bên Nợ chung bị xóa. */
async function performMirrorDelete(mirrorEntryId, sbToken) {
  const res = await callAccountFunction(sbToken, { type: 'debt-mirror-delete', entryId: mirrorEntryId });
  if (!res.ok) { if (!res.networkError) console.warn('performMirrorDelete không thành công:', res.reason); return { status: res.networkError ? 'network' : 'error' }; }
  return { status: 'ok' };
}
// Vừa mất mạng lại (Edge Function có thể đang "nguội" — cold start — hoặc mạng vẫn còn chập chờn vài
// giây đầu) rất dễ gặp lỗi KHÔNG được nhận diện là "lỗi mạng" (VD phản hồi lỗi 5xx/timeout thật sự từ
// server, không phải fetch() ném exception) dù chỉ là THOÁNG QUA — trước đây hễ không phải lỗi mạng
// rõ ràng là coi luôn là lỗi THẬT vĩnh viễn rồi ÂM THẦM bỏ job, khiến "Người khác nợ tôi" của thành
// viên KHÔNG BAO GIỜ nhận được dòng mirror mà không ai biết. Giờ cho thử lại tối đa
// MIRROR_JOB_MAX_ATTEMPTS lần (mỗi lần syncOutbox() được gọi mới tính là 1 lần) trước khi thật sự bỏ
// cuộc — lúc đó mới báo rõ qua lastSyncIssue, không im lặng nữa.
const MIRROR_JOB_MAX_ATTEMPTS = 6;
/** Làm hết hàng đợi mirror còn dang dở (state.pendingMirrors) — gọi từ syncOutbox() SAU khi outbox
 * chính đã trống hẳn (creditor/dòng sổ nợ chắc chắn đã có thật trên Supabase để lưu con trỏ mirror_*
 * ngược lại). Gặp lỗi MẠNG thì dừng lại NGAY, giữ nguyên hàng đợi để thử lại lần sau. */
async function processPendingMirrors() {
  // Không còn chặn theo isOnline() — xem giải thích ở syncOutbox() (chỗ gọi hàm này).
  if (!Array.isArray(state.pendingMirrors) || !state.pendingMirrors.length) return;
  const session = getSession();
  while (state.pendingMirrors.length) {
    const job = state.pendingMirrors[0];
    let result;
    try {
      if (job.op === 'add') {
        const creditor = getCreditor(job.creditorId);
        const entry = state.debtEntries.find((x) => x.id === job.entryId);
        // Dòng gốc đã bị xóa trong lúc job này còn chờ trong hàng đợi (deleteDebtEntry đã tự hủy job
        // 'add' tương ứng — nhánh này chỉ để phòng hờ) -> không còn gì để mirror, bỏ qua hẳn (không
        // phải lỗi cần báo, dòng gốc không còn tồn tại nữa).
        if (!creditor || !entry) { state.pendingMirrors.shift(); persist(); continue; }
        result = await performMirrorAdd(creditor, entry, { debtKind: job.debtKind, amount: job.amount, date: job.date, sbToken: session?.sbToken });
      } else if (job.op === 'update') {
        result = await performMirrorUpdate(job.mirrorEntryId, { amount: job.amount, date: job.date, debtKind: job.debtKind, sbToken: session?.sbToken });
      } else if (job.op === 'delete') {
        result = await performMirrorDelete(job.mirrorEntryId, session?.sbToken);
      } else {
        result = { status: 'error' };
      }
    } catch (e) {
      console.warn('processPendingMirrors: lỗi không mong đợi:', e);
      result = { status: 'error' };
    }
    if (result.status === 'ok') { state.pendingMirrors.shift(); persist(); continue; }
    // TÍNH số lần thử cho CẢ 'network' lẫn 'error' — 1 lỗi mạng "giả" (VD CORS bị chặn cấu hình sai,
    // trình duyệt báo y hệt lỗi mất mạng thật, KHÔNG cách nào phân biệt được) mà cứ mãi coi là "chờ có
    // mạng" thì sẽ lặp vô hạn không bao giờ tự hết — đủ số lần thử (dù trạng thái nào) mới thật sự bỏ
    // cuộc, xem MIRROR_JOB_MAX_ATTEMPTS.
    job.attempts = (job.attempts || 0) + 1;
    if (job.attempts >= MIRROR_JOB_MAX_ATTEMPTS) {
      // Kèm lý do LẦN CUỐI (nếu là lỗi thật, có `reason` từ Edge Function) vào thông báo — giúp biết
      // ngay cần sửa gì (VD thiếu SQL/cột) thay vì chỉ biết chung chung "không xong".
      const reasonSuffix = result.reason ? ` — lý do: ${result.reason}` : (result.status === 'network' ? ' — nghi do mạng/CORS, không phải do dữ liệu sai' : '');
      console.warn(`processPendingMirrors: bỏ qua job "${job.op}" sau ${job.attempts} lần thử vẫn không xong (trạng thái cuối: ${result.status}).`, result.reason || '');
      lastSyncIssue = { message: `Không tự điền được sang sổ riêng thành viên (đã thử ${job.attempts} lần)${reasonSuffix} — cần vào tay ghi lại khoản đó cho đúng.` };
      state.pendingMirrors.shift();
      persist();
      continue;
    }
    persist(); // lưu lại số lần thử (job.attempts) dù chưa bỏ job này khỏi hàng đợi
    break; // giữ job này ở ĐẦU hàng đợi, dừng lại thử tiếp lần sau (network, hoặc error chưa hết lượt)
  }
}
/** Ghi nợ mới. Truyền creditorId khi đã biết đúng chủ nợ (VD đang ở trang chi tiết 1 chủ nợ) — dùng
 * đúng sổ đó dù đang nợ hay đã trả hết. Không thì truyền creditorName (chủ nợ ngoài app, gõ tên tự
 * do) HOẶC memberUserId (chủ nợ là 1 THÀNH VIÊN trong sổ — tự lấy tên hiển thị của thành viên đó,
 * và tự tìm/mở đúng sổ gắn với thành viên này thay vì so tên) — tự tìm chủ nợ CÒN ĐANG NỢ trùng,
 * chưa có ai đang nợ thì tự mở 1 sổ nợ MỚI (không chồng vào sổ cũ đã trả hết). Truyền shared=true để
 * ghi vào "Nợ chung" (mọi thành viên cùng xem/sửa) thay vì sổ riêng tư mặc định. Mặc định KHÔNG đụng
 * thu/chi thật; chỉ tạo giao dịch THU khi addToTransactions=true — lúc vay/mua nợ là lúc tiền/hàng
 * VỀ TAY mình, ngược lại với lúc trả nợ (addDebtPayment bên dưới) mới là lúc tiền THẬT SỰ rời túi
 * (chi). Trả về { creditorId, transactionId }. */
export async function addDebtCharge({ creditorId, creditorName, memberUserId, shared, amount, date, description, categoryId, addToTransactions }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const chargeAmount = Number(amount) || 0;
  if (chargeAmount <= 0) throw new Error('Số tiền nợ phải lớn hơn 0.');
  const entryDate = date || new Date().toISOString().slice(0, 10);
  const isShared = !!shared;
  let creditor;
  if (creditorId) {
    creditor = getCreditor(creditorId);
    if (!creditor) throw new Error('Không tìm thấy chủ nợ.');
  } else if (memberUserId) {
    const member = getUser(memberUserId);
    if (!member) throw new Error('Không tìm thấy thành viên.');
    creditor = await ensureCreditor(member.name, sb, session, { shared: isShared, memberUserId });
  } else {
    const name = (creditorName || '').trim();
    if (!name) throw new Error('Cần nhập tên chủ nợ.');
    creditor = await ensureCreditor(name, sb, session, { shared: isShared });
  }

  const nowIso = new Date().toISOString(); // ghi sẵn NGAY LÚC NÀY, xem addTransaction() để biết vì sao.
  let txnRow = null;
  if (addToTransactions) {
    const catName = getCategory(categoryId)?.name || 'Mượn nợ';
    txnRow = {
      id: genId('txn'), type: 'income', amount: chargeAmount, category_id: categoryId || null,
      note: `${catName}: ${creditor.name}${description ? ' - ' + description : ''}`, txn_date: entryDate,
      user_id: session.id, recurring_id: null, created_at: nowIso,
    };
    const { error: txnErr } = await tryWrite(sb, 'transactions', 'insert', txnRow);
    if (txnErr) throw new Error('Không tạo được giao dịch, thử lại sau.');
  }
  const row = {
    id: genId('debtentry'), creditor_id: creditor.id, kind: 'charge', amount: chargeAmount,
    entry_date: entryDate, description: description || '',
    transaction_id: txnRow ? txnRow.id : null, user_id: session.id, shared: isShared, created_at: nowIso,
  };
  const { error } = await tryWrite(sb, 'debt_entries', 'insert', row);
  if (error) throw new Error('Không lưu được ghi nợ, thử lại sau.');
  if (txnRow) state.transactions.unshift(mapTransactionRow(txnRow));
  const entry = mapDebtEntryRow(row);
  state.debtEntries.unshift(entry);
  notify(); // vẽ ngay phần Nợ chung — KHÔNG chờ bước điền hộ mirror bên dưới (mạng chậm/edge function
            // phản hồi lâu sẽ khiến form Thêm giao dịch bị đứng chờ nếu để chặn ở đây).

  // Mượn của 1 thành viên trong sổ -> tự điền hộ vào sổ "Người khác nợ tôi" riêng của họ. LUÔN xếp
  // vào hàng đợi mirror rồi kích hoạt đồng bộ ngay nếu đang online (xem queueAndKickMirror) — thay vì
  // tự thử 1 lần riêng rồi báo qua toast (dễ bị bỏ lỡ, xem giải thích ở queueAndKickMirror) — dùng
  // CHUNG cơ chế banner/toast đồng bộ mà người dùng đã quen theo dõi. Nợ chung đã ghi đúng và hiện ra
  // ngay ở trên (xem notify() phía trên), không phải chờ bước điền hộ này mới thấy Nợ chung.
  if (memberUserId && !creditor.memberUserId) {
    // Đã chọn thành viên nhưng chủ nợ tìm/tạo ra lại KHÔNG gắn memberUserId — trước đây từng xảy ra
    // khi trùng tên với 1 sổ "người ngoài" có sẵn nên bị nhận nhầm (đã sửa ở findOpenCreditorByName),
    // giữ lại nhánh này để nếu vẫn xảy ra (sổ cũ tạo từ trước bản sửa) thì báo rõ thay vì im lặng.
    console.warn('addDebtCharge: chọn thành viên nhưng creditor không có memberUserId — có thể trùng tên với sổ nợ người ngoài có sẵn.');
  } else if (creditor.memberUserId) {
    queueAndKickMirror({ op: 'add', creditorId: creditor.id, entryId: entry.id, debtKind: 'charge', amount: chargeAmount, date: entryDate });
  }

  return { creditorId: creditor.id, transactionId: txnRow?.id || null };
}
/** Trả nợ (1 phần hoặc hết) cho 1 chủ nợ. Mặc định KHÔNG đụng thu/chi thật; chỉ tạo giao dịch chi
 * khi addToTransactions=true. Trả về { transactionId } cho nơi gọi cần đồng bộ tiếp (xem addDebtCharge). */
export async function addDebtPayment(creditorId, { amount, date, categoryId, description, addToTransactions }) {
  const creditor = getCreditor(creditorId);
  if (!creditor) throw new Error('Không tìm thấy chủ nợ.');
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const payAmount = Number(amount) || 0;
  if (payAmount <= 0) throw new Error('Số tiền trả phải lớn hơn 0.');
  const balance = creditorBalance(creditorId);
  if (payAmount > balance) throw new Error(`Số tiền không được vượt quá ${formatVND(balance)} (nợ còn lại).`);
  const payDate = date || new Date().toISOString().slice(0, 10);

  const nowIso = new Date().toISOString(); // ghi sẵn NGAY LÚC NÀY, xem addTransaction() để biết vì sao.
  let txnRow = null;
  if (addToTransactions) {
    const catName = getCategory(categoryId)?.name || 'Trả nợ';
    txnRow = {
      id: genId('txn'), type: 'expense', amount: payAmount, category_id: categoryId || null,
      note: `${catName}: ${creditor.name}`, txn_date: payDate, user_id: session.id, recurring_id: null, created_at: nowIso,
    };
    const { error: txnErr } = await tryWrite(sb, 'transactions', 'insert', txnRow);
    if (txnErr) throw new Error('Không tạo được giao dịch, thử lại sau.');
  }
  const row = {
    id: genId('debtentry'), creditor_id: creditorId, kind: 'payment', amount: payAmount,
    entry_date: payDate, description: description || '', transaction_id: txnRow ? txnRow.id : null,
    user_id: session.id, shared: !!creditor.shared, created_at: nowIso,
  };
  const { error: entryErr } = await tryWrite(sb, 'debt_entries', 'insert', row);
  if (entryErr) throw new Error(txnRow ? 'Đã tạo giao dịch nhưng chưa lưu được vào sổ nợ, thử lại sau.' : 'Không lưu được vào sổ nợ, thử lại sau.');

  if (txnRow) state.transactions.unshift(mapTransactionRow(txnRow));
  const entry = mapDebtEntryRow(row);
  state.debtEntries.unshift(entry);
  notify(); // vẽ ngay — không chờ bước điền hộ mirror bên dưới, xem addDebtCharge.

  // Trả cho 1 chủ nợ là thành viên trong sổ ĐÃ có mirror (đã từng mượn -> đã tự điền hộ sổ riêng của
  // họ, xem addDebtCharge) -> tự thêm dòng "collect" bên sổ riêng đó luôn, cho khớp với Nợ chung.
  // Xem giải thích queueAndKickMirror ở addDebtCharge.
  if (creditor.memberUserId && creditor.mirrorDebtorId) {
    queueAndKickMirror({ op: 'add', creditorId: creditor.id, entryId: entry.id, debtKind: 'payment', amount: payAmount, date: payDate });
  }

  return { transactionId: txnRow?.id || null };
}
/** Sửa 1 dòng ghi nợ/trả nợ. addToTransactions điều khiển việc tạo/xóa/đồng bộ giao dịch thu/chi thật
 * đi kèm (nếu có) — loại giao dịch tự suy ra từ kind (charge=thu, payment=chi, xem addDebtCharge). */
export async function updateDebtEntry(id, { amount, date, description, categoryId, addToTransactions }) {
  const e = state.debtEntries.find((x) => x.id === id);
  if (!e) throw new Error('Không tìm thấy dòng sổ nợ.');
  const creditor = getCreditor(e.creditorId);
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const newAmount = Number(amount) || 0;
  if (newAmount <= 0) throw new Error('Số tiền phải lớn hơn 0.');
  if (e.kind === 'payment') {
    // Dòng TRẢ nợ (giảm nợ): sửa số tiền vẫn không được vượt quá nợ còn lại — cộng lại đúng số tiền
    // CŨ của dòng này vào nợ còn lại trước (vì số cũ đã bị trừ rồi) rồi mới so sánh. VD: nợ còn
    // 200.000, dòng đang sửa vốn ghi 100.000 -> sửa lên tối đa 300.000 vẫn hợp lệ.
    const maxAmount = creditorBalance(e.creditorId) + e.amount;
    if (newAmount > maxAmount) throw new Error(`Số tiền không được vượt quá ${formatVND(maxAmount)} (nợ còn lại).`);
  }
  const newDate = date || e.date;
  const patch = { amount: newAmount, entry_date: newDate, description: description || '' };
  const txnType = e.kind === 'charge' ? 'income' : 'expense';

  let newTransactionId = e.transactionId;
  if (addToTransactions && !e.transactionId) {
    // Trước đây chưa đưa vào thu/chi, giờ tích chọn -> tạo mới giao dịch.
    const catName = getCategory(categoryId)?.name || (e.kind === 'charge' ? 'Mượn nợ' : 'Trả nợ');
    const note = e.kind === 'charge' ? `${catName}: ${creditor ? creditor.name : ''}${patch.description ? ' - ' + patch.description : ''}` : `${catName}: ${creditor ? creditor.name : ''}`;
    const txnRow = {
      id: genId('txn'), type: txnType, amount: newAmount, category_id: categoryId || null,
      note, txn_date: newDate, user_id: session.id, recurring_id: null, created_at: new Date().toISOString(),
    };
    const { error: txnErr } = await tryWrite(sb, 'transactions', 'insert', txnRow);
    if (txnErr) throw new Error('Không tạo được giao dịch, thử lại sau.');
    state.transactions.unshift(mapTransactionRow(txnRow));
    newTransactionId = txnRow.id;
  } else if (!addToTransactions && e.transactionId) {
    // Trước đây có đưa vào thu/chi, giờ bỏ tích -> xóa giao dịch đã tạo.
    await tryWrite(sb, 'transactions', 'delete', null, { column: 'id', value: e.transactionId });
    state.transactions = state.transactions.filter((t) => t.id !== e.transactionId);
    newTransactionId = null;
  } else if (addToTransactions && e.transactionId) {
    // Vẫn đưa vào thu/chi -> đồng bộ số tiền/ngày cho giao dịch đã có.
    const { error: txnErr } = await tryWrite(sb, 'transactions', 'update', { amount: newAmount, txn_date: newDate }, { column: 'id', value: e.transactionId });
    if (txnErr) throw new Error('Đã cập nhật sổ nợ nhưng chưa đồng bộ được giao dịch, thử lại sau.');
    const t = state.transactions.find((x) => x.id === e.transactionId);
    if (t) { t.amount = newAmount; t.date = newDate; }
  }
  patch.transaction_id = newTransactionId;
  const { error } = await tryWrite(sb, 'debt_entries', 'update', patch, { column: 'id', value: id });
  if (error) throw new Error('Không cập nhật được, thử lại sau.');
  Object.assign(e, { amount: newAmount, date: newDate, description: patch.description, transactionId: newTransactionId });
  if (creditor?.memberUserId) {
    // Nếu job 'add' mirror của ĐÚNG dòng này còn đang chờ trong hàng đợi (chưa từng mirror lên được,
    // do lúc tạo bị mất mạng) -> chỉ cần sửa lại số tiền/ngày NGAY trong job đó, khỏi cần thêm 1 job
    // riêng — lúc job đó chạy sẽ tự dùng đúng số liệu mới nhất, khỏi phải "update" cái chưa từng "add".
    const pendingAddIdx = Array.isArray(state.pendingMirrors) ? state.pendingMirrors.findIndex((j) => j.op === 'add' && j.entryId === e.id) : -1;
    if (pendingAddIdx > -1) {
      state.pendingMirrors[pendingAddIdx].amount = newAmount;
      state.pendingMirrors[pendingAddIdx].date = newDate;
      persist();
    } else if (e.mirrorEntryId) {
      // Đã mirror xong từ trước -> giờ sửa lại -> xếp vào hàng đợi + kích hoạt đồng bộ ngay nếu online.
      queueAndKickMirror({ op: 'update', entryId: e.id, mirrorEntryId: e.mirrorEntryId, amount: newAmount, date: newDate, debtKind: e.kind });
    }
  }
  notify();
}
/** Xóa 1 dòng ghi nợ/trả nợ. Nếu dòng có kèm giao dịch chi tiêu thật (đã tích "đưa vào chi tiêu") thì
 * xóa luôn giao dịch đó, và xóa luôn dòng mirror bên sổ riêng của thành viên nếu có (xem performMirrorAdd). */
export async function deleteDebtEntry(id) {
  const e = state.debtEntries.find((x) => x.id === id);
  if (!e) throw new Error('Không tìm thấy dòng sổ nợ.');
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const { error } = await tryWrite(sb, 'debt_entries', 'delete', null, { column: 'id', value: id });
  if (error) throw new Error('Không xóa được, thử lại sau.');
  if (e.transactionId) {
    await tryWrite(sb, 'transactions', 'delete', null, { column: 'id', value: e.transactionId });
    state.transactions = state.transactions.filter((t) => t.id !== e.transactionId);
  }
  state.debtEntries = state.debtEntries.filter((x) => x.id !== id);
  // Dòng gốc đã bị xóa -> hủy hẳn job 'add'/'update' mirror còn đang chờ của ĐÚNG dòng này trong hàng
  // đợi (nếu có) — không mirror gì cho 1 dòng đã không còn tồn tại nữa.
  if (Array.isArray(state.pendingMirrors) && state.pendingMirrors.length) {
    const before = state.pendingMirrors.length;
    state.pendingMirrors = state.pendingMirrors.filter((j) => j.entryId !== id);
    if (state.pendingMirrors.length !== before) persist();
  }
  if (e.mirrorEntryId) {
    // Dòng này ĐÃ mirror xong từ trước -> giờ xóa đi cũng phải xóa theo bên sổ riêng của thành viên
    // đó — xếp vào hàng đợi + kích hoạt đồng bộ ngay nếu online.
    queueAndKickMirror({ op: 'delete', entryId: id, mirrorEntryId: e.mirrorEntryId });
  }
  notify();
}
export async function updateCreditor(id, { name, note }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const patch = { name: (name || '').trim(), note: note || '' };
  if (!patch.name) throw new Error('Cần nhập tên chủ nợ.');
  const { error } = await sb.from('creditors').update(patch).eq('id', id);
  if (error) throw new Error('Không cập nhật được, thử lại sau.');
  const c = getCreditor(id);
  if (c) Object.assign(c, patch);
  notify();
}
/** Xóa HẲN mọi sổ nợ (mọi chu kỳ, kể cả đang nợ lẫn đã trả hết) mang tên này TRONG ĐÚNG 1 sổ (riêng
 * tư hoặc Nợ chung, không lẫn nhau) — dùng để dọn 1 tên khỏi gợi ý chủ nợ (VD tên gõ nhầm lúc test).
 * KHÔNG xóa các giao dịch chi tiêu thật đã trả trước đó. */
export async function deleteCreditorsByName(name, shared = false) {
  const key = (name || '').trim().toLowerCase();
  const matches = state.creditors.filter((c) => !!c.shared === !!shared && c.name.trim().toLowerCase() === key);
  if (!matches.length) return;
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const ids = matches.map((c) => c.id);
  const { error } = await sb.from('creditors').delete().in('id', ids);
  if (error) throw new Error('Không xóa được, thử lại sau.');
  state.creditors = state.creditors.filter((c) => !ids.includes(c.id));
  state.debtEntries = state.debtEntries.filter((e) => !ids.includes(e.creditorId));
  notify();
}

// ------------------------------------------------------------
// Công nợ PHẢI THU — người khác đang nợ MÌNH (ngược chiều với "Quản lý nợ" ở
// trên, nơi MÌNH nợ người khác). Theo TỪNG NGƯỜI NỢ (debtors), mỗi người 1 sổ
// riêng gồm 2 loại dòng: "lend" (cho vay/bán chịu — tăng số họ nợ mình) và
// "collect" (thu hồi — giảm). Còn nợ = tổng lend - tổng collect, tính ngay
// lúc đọc (không lưu cột riêng để khỏi lệch), y hệt cách tính bên trên.
//
// Khác 1 điểm so với "Quản lý nợ": ở đó ghi nợ VÀ trả nợ đều là giao dịch CHI
// (tự trả tiền); còn ở đây "cho vay" là tiền THẬT SỰ rời khỏi túi mình (tạo
// giao dịch CHI nếu tích "đưa vào chi tiêu") còn "thu tiền" là tiền THẬT SỰ
// về túi mình (tạo giao dịch THU) — ngược pha nhau. Riêng tư từng người dùng
// (RLS lọc theo user_id), KHÔNG hiện ở Tổng quan.
// ------------------------------------------------------------
function receivableEntriesOf(debtorId) { return state.receivableEntries.filter((e) => e.debtorId === debtorId); }
/** Còn nợ mình của 1 người = tổng cho vay - tổng đã thu. */
export function debtorBalance(debtorId) {
  return receivableEntriesOf(debtorId).reduce((s, e) => s + (e.kind === 'lend' ? e.amount : -e.amount), 0);
}
/** Danh sách người nợ kèm số dư còn nợ mình + ngày hoạt động gần nhất, mới nhất trước.
 * filters.status: 'active' (còn nợ mình) | 'paid' (đã trả hết). filters.shared: xem listCreditors(). */
export function listDebtors(filters = {}) {
  let list = state.debtors.filter((d) => !!d.shared === !!filters.shared).map((d) => {
    const entries = receivableEntriesOf(d.id);
    const lastDate = entries.reduce((m, e) => (e.date > m ? e.date : m), '');
    return { ...d, balance: debtorBalance(d.id), lastDate, entryCount: entries.length };
  });
  if (filters.status === 'active') list = list.filter((d) => d.balance > 0);
  else if (filters.status === 'paid') list = list.filter((d) => d.balance <= 0 && d.entryCount > 0);
  return list.sort((a, b) => b.lastDate.localeCompare(a.lastDate) || a.name.localeCompare(b.name));
}
export function getDebtor(id) { return state.debtors.find((d) => d.id === id); }
/** Toàn bộ TÊN người nợ đã dùng qua, không trùng (kể cả đã "đã trả hết") — gợi ý lúc ghi mới. */
export function listDebtorNames(shared = false) {
  const seen = new Set();
  const names = [];
  listDebtors({ shared }).forEach((d) => {
    const key = d.name.trim().toLowerCase();
    if (!seen.has(key)) { seen.add(key); names.push(d.name); }
  });
  return names;
}
/** Sổ của 1 người nợ (cho vay + thu tiền), mới nhất trước. */
export function listReceivableEntries(debtorId) {
  return receivableEntriesOf(debtorId).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}
/** Tổng sẽ thu về từ TẤT CẢ người nợ (của riêng người đang đăng nhập, không tính phần "chung"). */
export function totalReceivable() {
  return state.debtors.filter((d) => !d.shared).reduce((s, d) => s + Math.max(0, debtorBalance(d.id)), 0);
}

/** Chỉ tìm người nợ CÒN ĐANG NỢ (balance > 0) trong ĐÚNG 1 sổ (riêng tư/chung) — ưu tiên khớp theo
 * `memberUserId` nếu có truyền, không thì khớp theo tên. Người đã "đã trả hết" không tính, để lần
 * cho vay mới cùng tên/thành viên KHÔNG bị chồng vào sổ cũ đã đóng, mà tự mở 1 sổ mới. */
function findOpenDebtorByName(name, { shared = false, memberUserId = null } = {}) {
  const pool = state.debtors.filter((d) => !!d.shared === !!shared && debtorBalance(d.id) > 0);
  // Xem giải thích ở findOpenCreditorByName() — CHỈ khớp theo memberUserId khi có truyền, không rơi
  // xuống so tên nữa (tránh nhận nhầm sổ "người ngoài" trùng tên với 1 thành viên trong sổ).
  if (memberUserId) return pool.find((d) => d.memberUserId === memberUserId) || null;
  const key = (name || '').trim().toLowerCase();
  return pool.find((d) => !d.memberUserId && d.name.trim().toLowerCase() === key) || null;
}
async function ensureDebtor(name, sb, session, { shared = false, memberUserId = null } = {}) {
  const existing = findOpenDebtorByName(name, { shared, memberUserId });
  if (existing) return existing;
  const row = { id: genId('debtor'), name: name.trim(), note: '', user_id: session.id, shared, member_user_id: memberUserId || null };
  const { error } = await sb.from('debtors').insert(row);
  if (error) throw new Error('Không tạo được người nợ, thử lại sau.');
  const d = mapDebtorRow({ ...row, created_at: new Date().toISOString() });
  state.debtors.push(d);
  return d;
}
/** Cho vay/bán chịu mới. Truyền debtorId khi đã biết đúng người (VD đang ở trang chi tiết); không
 * thì truyền debtorName (người ngoài app) hoặc memberUserId (người nợ là 1 THÀNH VIÊN trong sổ) để
 * tự tìm người CÒN ĐANG NỢ trùng, chưa có ai đang nợ thì tự mở sổ MỚI. Mặc định KHÔNG đụng thu/chi
 * thật; chỉ tạo giao dịch CHI khi addToTransactions=true (tiền thật rời túi). Trả về
 * { debtorId, transactionId }. */
export async function addReceivableLend({ debtorId, debtorName, memberUserId, shared, amount, date, description, categoryId, addToTransactions }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const lendAmount = Number(amount) || 0;
  if (lendAmount <= 0) throw new Error('Số tiền cho vay phải lớn hơn 0.');
  const entryDate = date || new Date().toISOString().slice(0, 10);
  const isShared = !!shared;
  let debtor;
  if (debtorId) {
    debtor = getDebtor(debtorId);
    if (!debtor) throw new Error('Không tìm thấy người nợ.');
  } else if (memberUserId) {
    const member = getUser(memberUserId);
    if (!member) throw new Error('Không tìm thấy thành viên.');
    debtor = await ensureDebtor(member.name, sb, session, { shared: isShared, memberUserId });
  } else {
    const name = (debtorName || '').trim();
    if (!name) throw new Error('Cần nhập tên người nợ.');
    debtor = await ensureDebtor(name, sb, session, { shared: isShared });
  }

  let txnRow = null;
  if (addToTransactions) {
    txnRow = {
      id: genId('txn'), type: 'expense', amount: lendAmount, category_id: categoryId || null,
      note: `Cho vay: ${debtor.name}${description ? ' - ' + description : ''}`, txn_date: entryDate, user_id: session.id, recurring_id: null,
    };
    const { error: txnErr } = await sb.from('transactions').insert(txnRow);
    if (txnErr) throw new Error('Không tạo được giao dịch, thử lại sau.');
  }
  const row = {
    id: genId('recv'), debtor_id: debtor.id, kind: 'lend', amount: lendAmount,
    entry_date: entryDate, description: description || '',
    transaction_id: txnRow ? txnRow.id : null, user_id: session.id, shared: isShared,
  };
  const { error } = await sb.from('receivable_entries').insert(row);
  if (error) throw new Error('Không lưu được khoản cho vay, thử lại sau.');
  if (txnRow) state.transactions.unshift(mapTransactionRow({ ...txnRow, created_at: new Date().toISOString() }));
  state.receivableEntries.unshift(mapReceivableEntryRow({ ...row, created_at: new Date().toISOString() }));
  notify();
  return { debtorId: debtor.id, transactionId: txnRow?.id || null };
}
/** Thu tiền (1 phần hoặc hết) từ 1 người nợ. Mặc định KHÔNG đụng thu/chi thật; chỉ tạo giao dịch THU
 * khi addToTransactions=true (tiền thật về túi). Trả về { transactionId }. */
export async function addReceivableCollect(debtorId, { amount, date, categoryId, description, addToTransactions }) {
  const debtor = getDebtor(debtorId);
  if (!debtor) throw new Error('Không tìm thấy người nợ.');
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const collectAmount = Number(amount) || 0;
  if (collectAmount <= 0) throw new Error('Số tiền thu phải lớn hơn 0.');
  const collectDate = date || new Date().toISOString().slice(0, 10);

  let txnRow = null;
  if (addToTransactions) {
    txnRow = {
      id: genId('txn'), type: 'income', amount: collectAmount, category_id: categoryId || null,
      note: `Thu nợ: ${debtor.name}`, txn_date: collectDate, user_id: session.id, recurring_id: null,
    };
    const { error: txnErr } = await sb.from('transactions').insert(txnRow);
    if (txnErr) throw new Error('Không tạo được giao dịch, thử lại sau.');
  }
  const row = {
    id: genId('recv'), debtor_id: debtorId, kind: 'collect', amount: collectAmount,
    entry_date: collectDate, description: description || '', transaction_id: txnRow ? txnRow.id : null, user_id: session.id, shared: !!debtor.shared,
  };
  const { error: entryErr } = await sb.from('receivable_entries').insert(row);
  if (entryErr) throw new Error(txnRow ? 'Đã tạo giao dịch nhưng chưa lưu được vào sổ, thử lại sau.' : 'Không lưu được vào sổ, thử lại sau.');

  if (txnRow) state.transactions.unshift(mapTransactionRow({ ...txnRow, created_at: new Date().toISOString() }));
  state.receivableEntries.unshift(mapReceivableEntryRow({ ...row, created_at: new Date().toISOString() }));
  notify();
  return { transactionId: txnRow?.id || null };
}
/** Sửa 1 dòng cho vay/thu tiền. addToTransactions điều khiển việc tạo/xóa/đồng bộ giao dịch thật đi kèm (nếu có) — loại giao dịch tự suy ra từ kind (lend=chi, collect=thu). */
export async function updateReceivableEntry(id, { amount, date, description, categoryId, addToTransactions }) {
  const e = state.receivableEntries.find((x) => x.id === id);
  if (!e) throw new Error('Không tìm thấy dòng sổ.');
  const debtor = getDebtor(e.debtorId);
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const newAmount = Number(amount) || 0;
  if (newAmount <= 0) throw new Error('Số tiền phải lớn hơn 0.');
  const newDate = date || e.date;
  const patch = { amount: newAmount, entry_date: newDate, description: description || '' };
  const txnType = e.kind === 'lend' ? 'expense' : 'income';

  let newTransactionId = e.transactionId;
  if (addToTransactions && !e.transactionId) {
    // Trước đây chưa đưa vào thu/chi, giờ tích chọn -> tạo mới giao dịch.
    const note = e.kind === 'lend' ? `Cho vay: ${debtor ? debtor.name : ''}${patch.description ? ' - ' + patch.description : ''}` : `Thu nợ: ${debtor ? debtor.name : ''}`;
    const txnRow = {
      id: genId('txn'), type: txnType, amount: newAmount, category_id: categoryId || null,
      note, txn_date: newDate, user_id: session.id, recurring_id: null,
    };
    const { error: txnErr } = await sb.from('transactions').insert(txnRow);
    if (txnErr) throw new Error('Không tạo được giao dịch, thử lại sau.');
    state.transactions.unshift(mapTransactionRow({ ...txnRow, created_at: new Date().toISOString() }));
    newTransactionId = txnRow.id;
  } else if (!addToTransactions && e.transactionId) {
    // Trước đây có đưa vào thu/chi, giờ bỏ tích -> xóa giao dịch đã tạo.
    await sb.from('transactions').delete().eq('id', e.transactionId);
    state.transactions = state.transactions.filter((t) => t.id !== e.transactionId);
    newTransactionId = null;
  } else if (addToTransactions && e.transactionId) {
    // Vẫn đưa vào thu/chi -> đồng bộ số tiền/ngày cho giao dịch đã có.
    const { error: txnErr } = await sb.from('transactions').update({ amount: newAmount, txn_date: newDate }).eq('id', e.transactionId);
    if (txnErr) throw new Error('Đã cập nhật sổ nhưng chưa đồng bộ được giao dịch, thử lại sau.');
    const t = state.transactions.find((x) => x.id === e.transactionId);
    if (t) { t.amount = newAmount; t.date = newDate; }
  }
  patch.transaction_id = newTransactionId;
  const { error } = await sb.from('receivable_entries').update(patch).eq('id', id);
  if (error) throw new Error('Không cập nhật được, thử lại sau.');
  Object.assign(e, { amount: newAmount, date: newDate, description: patch.description, transactionId: newTransactionId });
  notify();
}
/** Xóa 1 dòng cho vay/thu tiền. Nếu dòng có kèm giao dịch thật (đã tích "đưa vào thu/chi") thì xóa luôn giao dịch đó. */
export async function deleteReceivableEntry(id) {
  const e = state.receivableEntries.find((x) => x.id === id);
  if (!e) throw new Error('Không tìm thấy dòng sổ.');
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const { error } = await sb.from('receivable_entries').delete().eq('id', id);
  if (error) throw new Error('Không xóa được, thử lại sau.');
  if (e.transactionId) {
    await sb.from('transactions').delete().eq('id', e.transactionId);
    state.transactions = state.transactions.filter((t) => t.id !== e.transactionId);
  }
  state.receivableEntries = state.receivableEntries.filter((x) => x.id !== id);
  notify();
}
export async function updateDebtor(id, { name, note }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const patch = { name: (name || '').trim(), note: note || '' };
  if (!patch.name) throw new Error('Cần nhập tên người nợ.');
  const { error } = await sb.from('debtors').update(patch).eq('id', id);
  if (error) throw new Error('Không cập nhật được, thử lại sau.');
  const d = getDebtor(id);
  if (d) Object.assign(d, patch);
  notify();
}
/** Xóa HẲN mọi sổ (mọi chu kỳ, kể cả đang nợ lẫn đã trả hết) mang tên này — dùng để dọn 1 tên khỏi
 * gợi ý người nợ (VD tên gõ nhầm lúc test). KHÔNG xóa các giao dịch thu/chi thật đã ghi trước đó. */
export async function deleteDebtorsByName(name, shared = false) {
  const key = (name || '').trim().toLowerCase();
  const matches = state.debtors.filter((d) => !!d.shared === !!shared && d.name.trim().toLowerCase() === key);
  if (!matches.length) return;
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const ids = matches.map((d) => d.id);
  const { error } = await sb.from('debtors').delete().in('id', ids);
  if (error) throw new Error('Không xóa được, thử lại sau.');
  state.debtors = state.debtors.filter((d) => !ids.includes(d.id));
  state.receivableEntries = state.receivableEntries.filter((e) => !ids.includes(e.debtorId));
  notify();
}

// ------------------------------------------------------------
// Thông báo — "gửi cho user khác" (ngay lập tức) hoặc "lịch nhắc" (đặt giờ,
// tự động gửi khi tới hạn), cả 2 đều tạo 1 dòng trong bảng notifications với
// status='pending'; 1 Edge Function được lịch chạy mỗi phút (pg_cron, xem
// docs/expense-app-setup.md mục 10) quét các dòng đã tới giờ (send_at null =
// gửi ngay) rồi tự gửi Thông báo đẩy (Web Push) và chuyển status='sent'.
// toUserId = null nghĩa là gửi cho TẤT CẢ mọi người dùng trong sổ.
//
// Trạng thái ĐÃ ĐỌC lưu riêng ở notification_reads (mỗi người 1 dòng cho mỗi
// thông báo mình đã xem) — vì 1 thông báo có thể gửi cho nhiều người (toUserId
// null) nên không thể dùng chung 1 cột "đã đọc" cho tất cả.
// ------------------------------------------------------------
export function listInboxNotifications() {
  const session = getSession();
  const readSet = new Set(state.notificationReads);
  return state.notifications
    .filter((n) => n.status === 'sent' && (n.toUserId === session.id || n.toUserId == null))
    .map((n) => ({ ...n, read: readSet.has(n.id) }))
    .sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
}
/** Lịch sử những thông báo CHÍNH MÌNH đã gửi (đã được hệ thống gửi xong). */
export function listSentNotifications() {
  const session = getSession();
  return state.notifications.filter((n) => n.fromUserId === session.id && n.status === 'sent').sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
}
/** Lịch nhắc CHÍNH MÌNH đã đặt, chưa tới giờ gửi (có thể hủy). */
export function listScheduledNotifications() {
  const session = getSession();
  return state.notifications.filter((n) => n.fromUserId === session.id && n.status === 'pending').sort((a, b) => (a.sendAt || '').localeCompare(b.sendAt || ''));
}
export function unreadInboxCount() {
  return listInboxNotifications().filter((n) => !n.read).length;
}
/** Gửi ngay 1 thông báo tự soạn cho 1 người khác (toUserId) hoặc tất cả (toUserId falsy). Có thể trễ tối đa ~1 phút (chờ lượt quét kế tiếp của pg_cron). */
export async function sendNotificationNow({ toUserId, title, body }) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const t = (title || '').trim();
  if (!t) throw new Error('Cần nhập tiêu đề thông báo.');
  const row = { id: genId('noti'), from_user_id: session.id, to_user_id: toUserId || null, title: t, body: (body || '').trim(), status: 'pending', send_at: null };
  const { error } = await sb.from('notifications').insert(row);
  if (error) throw new Error('Không gửi được thông báo, thử lại sau.');
  state.notifications.unshift(mapNotificationRow({ ...row, created_at: new Date().toISOString() }));
  notify();
}
/** Đặt lịch nhắc tới đúng ngày giờ `sendAt` (ISO hoặc chuỗi Date hiểu được) mới tự động gửi. */
export async function scheduleReminder({ toUserId, title, body, sendAt }) {
  if (!sendAt) throw new Error('Cần chọn ngày giờ nhắc.');
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const t = (title || '').trim();
  if (!t) throw new Error('Cần nhập tiêu đề thông báo.');
  const row = { id: genId('noti'), from_user_id: session.id, to_user_id: toUserId || null, title: t, body: (body || '').trim(), status: 'pending', send_at: new Date(sendAt).toISOString() };
  const { error } = await sb.from('notifications').insert(row);
  if (error) throw new Error('Không đặt được lịch nhắc, thử lại sau.');
  state.notifications.unshift(mapNotificationRow({ ...row, created_at: new Date().toISOString() }));
  notify();
}
/** Hủy 1 lịch nhắc CHƯA tới giờ gửi (đổi status='cancelled' — pg_cron sẽ bỏ qua). */
export async function cancelScheduledNotification(id) {
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const { error } = await sb.from('notifications').update({ status: 'cancelled' }).eq('id', id);
  if (error) throw new Error('Không hủy được, thử lại sau.');
  state.notifications = state.notifications.filter((n) => n.id !== id);
  notify();
}
export async function markNotificationRead(id) {
  if (state.notificationReads.includes(id)) return;
  const session = getSession();
  const sb = getSupabaseClient(session?.sbToken);
  const { error } = await sb.from('notification_reads').upsert({ notification_id: id, user_id: session.id }, { onConflict: 'notification_id,user_id' });
  if (error) return; // không nghiêm trọng — khỏi chặn thao tác của người dùng vì lỗi lưu "đã đọc"
  state.notificationReads.push(id);
  notify();
}
export async function markAllInboxRead() {
  const unread = listInboxNotifications().filter((n) => !n.read);
  for (const n of unread) await markNotificationRead(n.id);
}

// ---- Thông báo đẩy (Web Push) trên THIẾT BỊ đang dùng — bật/tắt riêng từng thiết bị ----
export async function isThisDevicePushEnabled() {
  return !!(await getCurrentEndpoint());
}
export async function enablePushOnThisDevice() {
  const session = getSession();
  const { endpoint, p256dh, auth } = await subscribeThisDevice();
  const sb = getSupabaseClient(session?.sbToken);
  const { error } = await sb.from('push_subscriptions').upsert(
    { id: genId('push'), user_id: session.id, endpoint, p256dh, auth_key: auth },
    { onConflict: 'endpoint' },
  );
  if (error) throw new Error('Không lưu được đăng ký nhận thông báo, thử lại sau.');
}
export async function disablePushOnThisDevice() {
  const session = getSession();
  const endpoint = await unsubscribeThisDevice();
  if (!endpoint) return;
  const sb = getSupabaseClient(session?.sbToken);
  await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
}

// ------------------------------------------------------------
// Session (đăng nhập hiện tại)
// ------------------------------------------------------------
export function getSession() { return state.session; }
export function setSession(session) { state.session = session; notify(); }
export function logout() {
  state.session = null;
  state.users = []; state.categories = []; state.transactions = []; state.budgets = []; state.recurring = []; state.savingsGoals = []; state.plans = []; state.creditors = []; state.debtEntries = [];
  state.debtors = []; state.receivableEntries = [];
  state.notifications = []; state.notificationReads = [];
  notify();
}
