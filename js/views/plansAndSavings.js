// Gộp 2 trang "Kế hoạch chi tiêu" và "Tiết kiệm" vào 1 mục menu duy nhất (2 tab bên trong) — trước
// đây 2 trang này tách riêng làm menu bị dài, trong khi cùng là "định hướng tiền sắp tới" nên gộp
// lại cho gọn. KHÔNG viết lại logic 2 trang — chỉ bọc 1 lớp tab mỏng bên ngoài, gọi thẳng lại
// render() của plans.js/savings.js (2 file đó không đổi gì, vẫn dùng độc lập được nếu cần).
import * as Plans from './plans.js';
import * as Savings from './savings.js';
import { pageHeader } from '../components/shell.js';

// null = chưa xác định tab nào -> lần render ĐẦU TIÊN sẽ tự chọn theo đúng đường dẫn đã bấm vào
// (#/tiet-kiem mở thẳng tab Tiết kiệm, đường dẫn khác mặc định tab Kế hoạch) — giữ cho link/lối tắt
// cũ (#/tiet-kiem) vẫn mở đúng chỗ. Sau đó giữ nguyên tab người dùng đang chọn khi màn tự vẽ lại vì
// dữ liệu đổi (giống cách debts.js/transactions.js giữ tab), không tự nhảy về lại mặc định.
let tab = null;

export function renderHeader(headerEl) {
  headerEl.innerHTML = pageHeader({ title: 'Kế hoạch & Tiết kiệm' });
}

export function render(contentEl) {
  if (tab === null) tab = location.hash.startsWith('#/tiet-kiem') ? 'savings' : 'plans';
  contentEl.innerHTML = `
    <div class="tabs mb-16">
      <button data-tab="plans" class="${tab === 'plans' ? 'active' : ''}">Kế hoạch</button>
      <button data-tab="savings" class="${tab === 'savings' ? 'active' : ''}">Tiết kiệm</button>
    </div>
    <div id="plans-savings-sub"></div>
  `;
  contentEl.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => { tab = btn.dataset.tab; render(contentEl); });
  });
  const sub = contentEl.querySelector('#plans-savings-sub');
  (tab === 'savings' ? Savings : Plans).render(sub);
}
