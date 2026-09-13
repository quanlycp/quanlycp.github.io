import * as S from './state.js';
import { buildShell, updateActiveNav, updateSyncBanner } from './components/shell.js';
import { closeAllModals } from './components/modal.js';
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
function trySyncNow() {
  S.syncOutbox();
  if (root) updateSyncBanner(S.pendingSyncCount(), S.getSyncIssue());
}
window.addEventListener('online', trySyncNow);
window.addEventListener('offline', () => { if (root) updateSyncBanner(S.pendingSyncCount(), S.getSyncIssue()); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') trySyncNow(); });
window.addEventListener('focus', trySyncNow);
setInterval(() => {
  if (navigator.onLine !== false && S.pendingSyncCount() > 0) S.syncOutbox();
}, 5000);

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
// updateViaCache:'none' + tự reload khi có bản mới kiểm soát trang: để mỗi
// lần code cập nhật, tab ĐANG MỞ (không riêng gì lần mở mới) tự nhận bản mới
// và tự tải lại — không cần ai bấm F12/xóa cache tay mỗi lần có bản mới nữa.
if ('serviceWorker' in navigator) {
  let reloadedForNewSw = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedForNewSw) return;
    reloadedForNewSw = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' })
      .then((reg) => { reg.update().catch(() => {}); })
      .catch((e) => console.warn('Không đăng ký được service worker.', e));
  });
}

// Mọi thay đổi dữ liệu (xóa/tạo/sửa...) đều gọi notify() và kích hoạt render
// lại ở đây — nhưng đây KHÔNG phải là chuyển trang, nên không cuộn lên đầu,
// để thao tác xong người dùng vẫn đang đứng đúng chỗ vừa thao tác.
S.subscribe(() => {
  if (root) renderApp({ scrollTop: false });
});
