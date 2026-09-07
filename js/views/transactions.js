import * as S from '../state.js';
import { icon } from '../icons.js';
import { pageHeader } from '../components/shell.js';
import { emptyState } from '../components/ui.js';
import { openTransactionForm } from '../components/txnForm.js';
import { confirmDialog, openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { formatVND, formatDate, debounce } from '../utils.js';

// filters.month: 'YYYY-MM' hoặc '' (Tất cả). Mọi giao dịch được lưu vĩnh viễn theo đúng ngày thật
// (không tự xóa/gộp/chốt sổ gì cả) nên chọn lại bất kỳ tháng nào trong quá khứ luôn ra đúng dữ liệu
// gốc — không cần thêm cơ chế "lưu định kỳ đầu tháng" nào khác.
function currentMonthValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
// Mặc định mở trang là đúng THÁNG HIỆN TẠI (không để trống) — muốn xem tất cả các tháng thì bấm "x" bỏ lọc.
let filters = { type: '', categoryId: '', userId: '', q: '', month: currentMonthValue() };

export function renderHeader(headerEl) {
  headerEl.innerHTML = pageHeader({ title: 'Giao dịch' });
}

export function render(contentEl, filterEl) {
  renderFilterBar(contentEl, filterEl);
  renderList(contentEl);

  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.innerHTML = icon('plus');
  fab.addEventListener('click', () => openTransactionForm({}));
  document.body.appendChild(fab);
}

/** Vẽ riêng thanh lọc (tách khỏi render() ở trên) để khi đổi/xóa lọc tháng chỉ cần gọi lại đúng hàm
 * này + renderList() — KHÔNG gọi lại render() (sẽ tạo thêm 1 nút "+" (FAB) chồng lên nút cũ, vì FAB
 * do render() tự thêm vào document.body mỗi lần gọi, không nằm trong contentEl/filterEl bị xóa
 * innerHTML sạch mỗi lần vẽ lại). */
function renderFilterBar(contentEl, filterEl) {
  const members = S.listMembers();
  const categories = S.listCategories();

  filterEl.innerHTML = `
    <div class="flex gap-8 mb-8" style="flex-wrap:wrap">
      <div class="flex items-center gap-4">
        <input type="month" id="f-month" class="pill-select" value="${filters.month}" aria-label="Chọn tháng"/>
        ${filters.month ? `<button type="button" class="icon-btn" id="f-month-clear" aria-label="Bỏ lọc tháng">${icon('x', 'icon-sm')}</button>` : ''}
      </div>
      <select id="f-type" class="pill-select">
        <option value="">Tất cả</option>
        <option value="expense" ${filters.type === 'expense' ? 'selected' : ''}>Khoản chi</option>
        <option value="income" ${filters.type === 'income' ? 'selected' : ''}>Khoản thu</option>
      </select>
      <select id="f-cat" class="pill-select">
        <option value="">Mọi danh mục</option>
        ${categories.map((c) => `<option value="${c.id}" ${filters.categoryId === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select>
      ${members.length > 1 ? `
      <select id="f-user" class="pill-select">
        <option value="">Mọi người</option>
        ${members.map((u) => `<option value="${u.id}" ${filters.userId === u.id ? 'selected' : ''}>${u.name}</option>`).join('')}
      </select>` : ''}
    </div>
    <div class="field" style="margin-bottom:12px">
      <input id="f-search" placeholder="Tìm theo ghi chú/danh mục..." value="${filters.q}"/>
    </div>
  `;
  filterEl.querySelector('#f-month').addEventListener('change', (e) => {
    filters.month = e.target.value;
    renderFilterBar(contentEl, filterEl);
    renderList(contentEl);
  });
  const fMonthClear = filterEl.querySelector('#f-month-clear');
  if (fMonthClear) fMonthClear.addEventListener('click', () => {
    filters.month = '';
    renderFilterBar(contentEl, filterEl);
    renderList(contentEl);
  });
  filterEl.querySelector('#f-type').addEventListener('change', (e) => { filters.type = e.target.value; renderList(contentEl); });
  filterEl.querySelector('#f-cat').addEventListener('change', (e) => { filters.categoryId = e.target.value; renderList(contentEl); });
  const fUser = filterEl.querySelector('#f-user');
  if (fUser) fUser.addEventListener('change', (e) => { filters.userId = e.target.value; renderList(contentEl); });
  filterEl.querySelector('#f-search').addEventListener('input', debounce((e) => { filters.q = e.target.value; renderList(contentEl); }, 250));
}

function renderList(contentEl) {
  let range = null;
  if (filters.month) {
    const [y, m] = filters.month.split('-').map(Number);
    range = S.monthRange(y, m);
  }
  const list = S.listTransactions({ ...filters, from: range?.from, to: range?.to });
  const totalExpense = list.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const totalIncome = list.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const monthLabel = filters.month ? `Tháng ${Number(filters.month.split('-')[1])}/${filters.month.split('-')[0]}` : '';

  // Nhóm theo ngày để dễ theo dõi (danh sách đã sắp xếp mới nhất trước).
  const groups = [];
  for (const t of list) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) last.items.push(t);
    else groups.push({ date: t.date, items: [t] });
  }

  contentEl.innerHTML = `
    <div class="card card-pad mb-16">
      ${monthLabel ? `<div class="fw-700 text-sm mb-8">${monthLabel}</div>` : ''}
      <div class="oc-line"><span>Tổng thu</span><b style="color:var(--success)">+${formatVND(totalIncome)}</b></div>
      <div class="oc-line"><span>Tổng chi</span><b style="color:var(--danger)">-${formatVND(totalExpense)}</b></div>
      <div class="oc-line"><span>Số dư</span><b style="color:${totalIncome - totalExpense >= 0 ? 'var(--success)' : 'var(--danger)'}">${formatVND(totalIncome - totalExpense)}</b></div>
    </div>
    ${list.length ? groups.map((g) => `
      <div class="mb-16">
        <div class="text-sm fw-700 text-muted mb-6">${formatDate(g.date)}</div>
        <div class="card">
          ${g.items.map((t) => transactionRowHtml(t)).join('')}
        </div>
      </div>
    `).join('') : `<div class="card card-pad">${emptyState({ iconName: 'wallet', title: 'Chưa có giao dịch nào', message: 'Bấm nút + để thêm giao dịch đầu tiên.' })}</div>`}
  `;

  contentEl.querySelectorAll('[data-txn]').forEach((row) => {
    row.addEventListener('click', () => openTxnDetail(S.getTransaction(row.dataset.txn)));
  });
}

function transactionRowHtml(t) {
  const cat = S.getCategory(t.categoryId);
  const isExpense = t.type === 'expense';
  const user = S.getUser(t.userId);
  return `
    <div class="list-row" data-txn="${t.id}" style="cursor:pointer">
      <div class="row-thumb" style="background:${cat ? cat.color : '#94a3b8'}">${icon(cat ? cat.icon : 'tag', 'icon-sm')}</div>
      <div class="row-main">
        <div class="row-title">${cat ? cat.name : 'Không rõ danh mục'}</div>
        <div class="row-sub">${t.note ? t.note + ' · ' : ''}${user ? user.name : ''}</div>
      </div>
      <div class="row-end"><span class="amount" style="color:${isExpense ? 'var(--danger)' : 'var(--success)'}">${isExpense ? '-' : '+'}${formatVND(t.amount)}</span></div>
    </div>`;
}

function openTxnDetail(t) {
  if (!t) return;
  const cat = S.getCategory(t.categoryId);
  openModal({
    title: 'Giao dịch',
    bodyHtml: `
      <div class="oc-line"><span>Danh mục</span><b>${cat ? cat.name : 'Không rõ danh mục'}</b></div>
      <div class="oc-line"><span>Số tiền</span><b>${formatVND(t.amount)}</b></div>
      <div class="oc-line"><span>Ngày</span><b>${formatDate(t.date)}</b></div>
      ${t.note ? `<div class="oc-line"><span>Ghi chú</span><b>${t.note}</b></div>` : ''}
    `,
    footHtml: `
      <button class="btn btn-outline btn-block" data-edit>${icon('edit', 'icon-sm')} Sửa</button>
      <button class="btn btn-danger-outline btn-block" data-del style="margin-top:8px">${icon('trash', 'icon-sm')} Xóa</button>
    `,
    onMount(sheet, closeFn) {
      sheet.querySelector('[data-edit]').addEventListener('click', () => { closeFn(); openTransactionForm({ transaction: t }); });
      sheet.querySelector('[data-del]').addEventListener('click', () => {
        closeFn();
        confirmDialog({
          title: 'Xóa giao dịch?', message: 'Không thể hoàn tác sau khi xóa.', confirmLabel: 'Xóa', danger: true,
          onConfirm: async () => {
            try { await S.deleteTransaction(t.id); toast('Đã xóa giao dịch', 'success'); }
            catch (err) { toast(err.message || 'Có lỗi xảy ra', 'error'); }
          },
        });
      });
    },
  });
}
