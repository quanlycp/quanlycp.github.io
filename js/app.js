import * as S from './state.js';
import { buildShell, updateActiveNav, updateSyncBanner } from './components/shell.js';
import { closeAllModals } from './components/modal.js';
import { toast } from './components/toast.js';
import { renderLogin } from './views/login.js';
import { renderChangePassword } from './views/changePassword.js';

import * as Dashboard from './views/dashboard.js';
import * as Transactions from './views/transactions.js';
import * as Budgets from './views/budgets.js';
import * as Reports from './views/reports.js';
import * as Recurring from './views/recurring.js';
import * as PlansAndSavings from './views/plansAndSavings.js';
import * as Debts from './views/debts.js';
import * as Notifications from './views/notifications.js';
import * as Users from './views/users.js';
import * as Settings from './views/settings.js';
import * as ActivityLog from './views/activityLog.js';
import * as ChangePasswordSelf from './views/changePasswordSelf.js';

const ROUTES = [
  { re: /^#\/$/, view: Dashboard },
  { re: /^#\/giao-dich$/, view: Transactions },
  { re: /^#\/danh-muc$/, view: Budgets },
  { re: /^#\/bao-cao$/, view: Reports },
  { re: /^#\/dinh-ky$/, view: Recurring },
  { re: /^#\/ke-hoach$/, view: PlansAndSavings },
  { re: /^#\/no$/, view: Debts },
  { re: /^#\/tiet-kiem$/, view: PlansAndSavings },
  { re: /^#\/thong-bao$/, view: Notifications },
  { re: /^#\/nguoi-dung$/, view: Users, ownerOnly: true },
  { re: /^#\/cai-dat$/, view: Settings, ownerOnly: true },
  { re: /^#\/nhat-ky$/, view: ActivityLog, ownerOnly: true },
  { re: /^#\/doi-mat-khau$/, view: ChangePasswordSelf },
];

let root;
let shellBuilt = false;

function splitHash() {
  const raw = location.hash || '#/';
  const [path, qs] = raw.split('?');
  return { path: path || '#/', query: new URLSearchParams(qs || '') };
}

function matchRoute(path) {
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) return { view: r.view, ownerOnly: !!r.ownerOnly };
  }
  return null;
}

function clearFabs() { document.querySelectorAll('.fab').forEach((el) => el.remove()); }

function renderApp({ scrollTop = true } = {}) {
  const session = S.getSession();

  if (!session) {
    shellBuilt = false;
    renderLogin(root, () => renderApp());
    return;
  }

  if (session.mustChangePassword) {
    shellBuilt = false;
    renderChangePassword(root, session.id, () => renderApp(), { forced: true });
    return;
  }

  const isOwner = session.role === 'owner';
  const { path, query } = splitHash();
  let match = matchRoute(path);
  if (!match || (match.ownerOnly && !isOwner)) {
    if (location.hash !== '#/') { location.hash = '#/'; return; }
    match = matchRoute('#/');
  }

  if (!shellBuilt) {
    buildShell(root, isOwner);
    shellBuilt = true;
  }
  document.getElementById('brand-name').textContent = S.getSettings().householdName;

  const headerEl = document.getElementById('app-header');
  const filterEl = document.getElementById('filter-slot');
  const contentEl = document.getElementById('app-content');
  clearFabs();
  filterEl.innerHTML = '';
  if (scrollTop) window.scrollTo(0, 0);

  if (match.view.renderHeader) match.view.renderHeader(headerEl);
  match.view.render(contentEl, filterEl, query);
  updateActiveNav(path);
  updateSyncBanner(S.pendingSyncCount(), S.getSyncIssue());
}

window.addEventListener('hashchange', () => {
  closeAllModals();
  renderApp();
  // Vào trang Công nợ luôn tự tải lại dữ liệu mới nhất ở NỀN (không chặn màn hình) — trang này hay
  // có dữ liệu do NGƯỜI KHÁC ghi hộ (VD Mượn nợ chọn 1 thành viên tự điền sang "Người khác nợ tôi"
  // của họ qua Edge Function), phiên hiện tại không tự biết để cập nhật cho tới khi tải lại trang
  // (đăng xuất/đăng nhập lại) — giờ chỉ cần bấm vào đúng trang Công nợ là đã tự cập nhật, khỏi phải
  // thoát app ra vào lại. Đặt SAU renderApp() (đã tự vẽ ngay bằng dữ liệu cũ, không phải chờ mạng).
  if (splitHash().path === '#/no') S.refresh();
});
window.addEventListener('qtd:logout', () => { closeAllModals(); S.logout(); location.hash = '#/'; renderApp(); });

// Có mạng trở lại (sau khi mất mạng) -> tự đẩy các thay đổi đã ghi tạm lúc
// offline (outbox trong state.js) lên máy chủ NGAY, khỏi cần đợi thao tác kế
// tiếp mới nhận ra là đã có mạng. Bắt CẢ 3 kiểu tín hiệu vì trên điện thoại,
// tình huống thường gặp nhất là: đang mất mạng -> khóa màn hình/chuyển app
// khác -> bật lại wifi/4G -> mở app lên lại — lúc đó trình duyệt hay chỉ báo
// lại đúng lúc quay lại app (visibilitychange/focus) chứ 'online' có thể đã
// bắn ra từ lúc app đang ở NỀN và bị trình duyệt bỏ qua/trì hoãn xử lý:
// - 'online': có mạng lại trong khi app đang mở/đang xem.
// - visibilitychange/focus: MỞ LẠI app (từ nền/khóa màn hình) — luôn thử
//   đồng bộ ngay lúc này, không cần biết trước đó 'online' đã bắn hay chưa.
// - setInterval: hẹn giờ dự phòng, rút ngắn còn 5 giây (thay vì 20 giây) vì
//   bản thân việc kiểm tra gần như miễn phí (chỉ thật sự gọi mạng khi ĐANG
//   có việc chờ đồng bộ) — tránh cảm giác "phải chờ lâu mới thấy đồng bộ".
// Trước đây "Đang đồng bộ..." cứ hiện mãi mà không có gì báo lúc XONG (chỉ tự ẩn banner đi, dễ tưởng
// nhầm là "không biết có xong chưa") — giờ so sánh số việc còn chờ TRƯỚC/SAU mỗi lần thử: từ >0 về
// hẳn 0 mới coi là "vừa đồng bộ xong" -> báo 1 toast thành công rõ ràng. KHÔNG còn đòi hỏi thêm
// "không có lỗi thật" (S.getSyncIssue()) như trước — pendingSyncCount() giờ đã tự loại các item bị
// đánh dấu `stuck` (lỗi thật lặp lại nhiều lần, xem state.js) ra khỏi số đếm, nhưng banner đỏ của
// item đó vẫn hiện riêng qua getSyncIssue(); nếu vẫn bắt đợi hết sạch lỗi mới báo "xong" thì 1 item
// bị kẹt (có thể không bao giờ tự hết) sẽ chặn đứng luôn thông báo "xong" của MỌI thay đổi khác,
// không liên quan, mãi mãi.
async function trySyncNow() {
  const hadPending = S.pendingSyncCount() > 0;
  await S.syncOutbox();
  if (hadPending && S.pendingSyncCount() === 0) {
    toast('Đã đồng bộ xong tất cả thay đổi lên máy chủ', 'success');
  }
  if (root) updateSyncBanner(S.pendingSyncCount(), S.getSyncIssue());
}
window.addEventListener('online', trySyncNow);
window.addEventListener('offline', () => { if (root) updateSyncBanner(S.pendingSyncCount(), S.getSyncIssue()); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') trySyncNow(); });
window.addEventListener('focus', trySyncNow);
// Hẹn giờ dưới đây có 2 việc TÁCH RIÊNG nhau:
// 1. Cập nhật lại banner mỗi 5 giây (rẻ, chỉ đọc navigator.onLine + vẽ lại DOM, không gọi mạng) — LUÔN
//    làm, bất kể có gì để đồng bộ hay không, để không rơi vào lỗi cũ đã sửa: dải "Đang mất mạng" đứng
//    yên mãi vì không có gì khiến nó tự vẽ lại.
// 2. THỬ GỌI MẠNG (trySyncNow) — CÓ xét navigator.onLine trước ở đây, vì gọi mỗi 5 giây dù RÕ RÀNG
//    đang mất mạng (cờ báo false) là vô ích/gây cảm giác "lúc nào cũng đồng bộ" dù biết chắc không có
//    mạng. Không lo bị kẹt cứng như trước vì CÒN NHIỀU đường KHÁC gọi trySyncNow() KHÔNG xét cờ này:
//    - 'online': bắn ra ngay lúc mạng thật sự có lại — đường CHÍNH để phát hiện.
//    - focus/visibilitychange: mở lại app — cũng không xét cờ, thử lại ngay lúc quay lại app.
//    - hẹn giờ AN TOÀN bên dưới (60 giây, KHÔNG xét cờ) — phòng hờ cả 3 đường trên đều không bắn ra
//      (cờ bị kẹt báo sai mãi) thì vẫn tự sửa lại được, chỉ là chậm hơn (tối đa 1 phút) thay vì mỗi
//      5 giây — cân bằng giữa "không ngu ngốc cứ thử hoài lúc rõ ràng mất mạng" và "không bao giờ bị
//      kẹt cứng nếu cờ báo sai".
setInterval(() => {
  if (root) updateSyncBanner(S.pendingSyncCount(), S.getSyncIssue());
  if (navigator.onLine !== false && S.pendingSyncCount() > 0) trySyncNow();
}, 5000);
setInterval(() => { if (S.pendingSyncCount() > 0) trySyncNow(); }, 60000);

window.addEventListener('DOMContentLoaded', async () => {
  root = document.getElementById('root');
  // Vẽ ngay bằng dữ liệu cache cũ (localStorage, không chờ mạng) cho đỡ phải
  // nhìn "Đang tải ứng dụng..." lâu — S.refresh() ở dưới tải dữ liệu mới nhất
  // ở nền, xong tự notify() để vẽ lại (xem S.subscribe bên dưới).
  await S.init();
  renderApp();
  S.refresh();
});

// Đăng ký service worker — Chrome/Android chỉ cho "Thêm vào màn hình chính"
// chạy KHÔNG có thanh địa chỉ (như 1 app riêng) khi trang có service worker
// hợp lệ; thiếu nó, "Thêm vào màn hình chính" chỉ tạo 1 shortcut mở trong
// Chrome bình thường — đúng hiện tượng thấy thanh địa chỉ như đang mở Chrome.
//
// updateViaCache:'none': mỗi lần code cập nhật, tab ĐANG MỞ (không riêng gì lần mở mới) tự nhận
// bản mới ở NỀN — không cần ai bấm F12/xóa cache tay.
//
// LỖI THẬT vừa tìm ra (rất có thể là lý do "sửa hoài không thấy tác dụng" suốt các vòng trước): gọi
// reg.update() CHỈ 1 LẦN lúc mới mở trang (sự kiện 'load' chỉ bắn ra đúng 1 lần) — sau đó KHÔNG CÓ GÌ
// chủ động kiểm tra lại bản mới nữa nếu tab cứ để MỞ LIÊN TỤC (như lúc đang thử nghiệm nhiều bản sửa
// liên tiếp trong 1 phiên dài) — trình duyệt tự kiểm tra định kỳ nhưng RẤT THƯA (có thể cả giờ/cả
// ngày mới tới lượt), khiến tab có thể vẫn đang chạy ĐÚNG bản code từ lúc mở lên ban đầu suốt nhiều
// giờ, dù đã có hàng chục bản sửa mới. Giờ chủ động tự kiểm tra lại mỗi 30 giây trong lúc tab mở.
//
// Và thay vì CHỈ hiện dải "Tải lại ngay" chờ người dùng tự bấm (rất dễ bị bỏ qua/không để ý), giờ tự
// TẢI LẠI NGAY LẬP TỨC mỗi khi phát hiện bản mới — TRỪ lúc đang gõ dở 1 ô nhập liệu (input/textarea)
// thì mới hoãn lại, hiện dải này để không ép mất chữ đang gõ. Làm vậy vừa không mất dữ liệu đang gõ
// dở (vấn đề ban đầu khiến bỏ hẳn tự động tải lại), vừa đảm bảo bản mới ÁP DỤNG NGAY chứ không phải
// chờ người dùng hiểu ý nghĩa dải thông báo rồi tự bấm.
function isTypingSomewhere() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
if ('serviceWorker' in navigator) {
  const hadControllerAtLoad = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Lần "claim" ĐẦU TIÊN (mở app lần đầu, trước đó chưa có SW nào kiểm soát) cũng bắn ra sự kiện
    // này nhưng KHÔNG phải "có bản mới" — chỉ xử lý khi ĐANG có 1 SW khác kiểm soát rồi mới đổi sang
    // SW mới (đúng nghĩa "vừa cập nhật"), tránh tải lại nhầm ngay lần đầu cài đặt.
    if (!hadControllerAtLoad) return;
    if (isTypingSomewhere()) showUpdateBanner();
    else location.reload();
  });
  let swReg = null;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' })
      .then((reg) => { swReg = reg; reg.update().catch(() => {}); })
      .catch((e) => console.warn('Không đăng ký được service worker.', e));
  });
  setInterval(() => { if (swReg) swReg.update().catch(() => {}); }, 30000);
}
function showUpdateBanner() {
  if (document.getElementById('update-banner')) return;
  const el = document.createElement('div');
  el.id = 'update-banner';
  el.className = 'update-banner';
  el.innerHTML = '<span>Đã có bản cập nhật mới.</span><button type="button" id="update-banner-btn">Tải lại ngay</button>';
  document.body.appendChild(el);
  el.querySelector('#update-banner-btn').addEventListener('click', () => location.reload());
  // Vừa xong ô đang gõ (rời khỏi input/textarea, VD bấm nút khác) mà dải này vẫn còn hiện -> giờ an
  // toàn để tự tải lại luôn, khỏi phải chờ người dùng để ý bấm "Tải lại ngay".
  document.addEventListener('focusout', function autoReloadWhenIdle() {
    setTimeout(() => {
      if (document.getElementById('update-banner') && !isTypingSomewhere()) {
        document.removeEventListener('focusout', autoReloadWhenIdle);
        location.reload();
      }
    }, 300);
  });
}

// Mọi thay đổi dữ liệu (xóa/tạo/sửa...) đều gọi notify() và kích hoạt render
// lại ở đây — nhưng đây KHÔNG phải là chuyển trang, nên không cuộn lên đầu,
// để thao tác xong người dùng vẫn đang đứng đúng chỗ vừa thao tác.
S.subscribe(() => {
  if (root) renderApp({ scrollTop: false });
});
