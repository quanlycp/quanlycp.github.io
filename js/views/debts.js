// Công nợ — 2 CHIỀU dùng chung 1 màn hình (chuyển bằng tab trên cùng):
//  - "Tôi nợ": mình nợ người khác, theo từng CHỦ NỢ (creditors/debt_entries).
//  - "Người khác nợ tôi": người khác nợ mình, theo từng NGƯỜI NỢ (debtors/
//    receivable_entries) — xem state.js.
// 2 chiều giống hệt nhau về luồng thao tác (ghi tăng nợ / ghi giảm nợ / đổi
// tên / sửa & xóa từng dòng), chỉ khác chữ nghĩa + hàm state.js đứng sau nên
// gom vào object DIRECTIONS bên dưới thay vì chép lại 2 lần.
import * as S from '../state.js';
import { icon } from '../icons.js';
import { pageHeader } from '../components/shell.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { emptyState } from '../components/ui.js';
import { toast } from '../components/toast.js';
import { formatVND, formatDate, formatNumber, attachMoneyInput, unformatMoney } from '../utils.js';

const DIRECTIONS = {
  owe: {
    tabLabel: 'Tôi nợ',
    listIcon: 'creditCard',
    totalLabel: 'Tổng còn nợ',
    totalColor: 'var(--danger)',
    outstandingColor: 'var(--danger)',
    settledColor: 'var(--success)',
    counterpartLabel: 'Chủ nợ', counterpartPlaceholder: 'VD: Tạp hóa A',
    renameTitle: 'Đổi tên chủ nợ',
    addBtnLabel: 'Ghi nợ mới',
    increaseModalTitle: 'Ghi nợ mới', increaseDetailBtn: 'Ghi nợ thêm',
    increaseDateLabel: 'Ngày mua nợ', increaseDescLabel: 'Mua gì (không bắt buộc)', increaseDescPlaceholder: 'VD: gạo, mắm, dầu ăn',
    increaseAmountLabel: 'Số tiền nợ', increaseSubmitLabel: 'Ghi nợ',
    increaseTxnLabel: 'Đưa vào chi tiêu tháng này', increaseTxnType: 'expense',
    increaseEntryLabel: 'Ghi nợ', increaseIcon: 'cart',
    decreaseTitle: (name) => `Trả nợ — ${name}`, decreaseDetailBtn: 'Trả nợ',
    decreaseAmountLabel: 'Số tiền trả', decreaseDateLabel: 'Ngày trả', decreaseSubmitLabel: 'Xác nhận trả nợ',
    decreaseTxnLabel: 'Đưa vào chi tiêu tháng này', decreaseTxnType: 'expense',
    decreaseEntryLabel: 'Trả nợ', decreaseIcon: 'check',
    entryEditIncreaseTitle: 'Sửa ghi nợ', entryEditDecreaseTitle: 'Sửa trả nợ',
    entryDetailIncreaseTitle: 'Dòng ghi nợ', entryDetailDecreaseTitle: 'Dòng trả nợ',
    entryDescLabel: 'Mua gì',
    statusActiveTab: 'Đang nợ', statusPaidTab: 'Đã trả hết',
    statusActiveLabel: 'còn nợ', statusPaidLabel: 'đã hết nợ',
    emptyActive: { title: 'Chưa có khoản nợ nào', message: 'Bấm "Ghi nợ mới" để ghi lại khoản mua/vay nợ theo từng chủ nợ.' },
    emptyPaid: { title: 'Chưa có chủ nợ nào trả hết', message: 'Chủ nợ trả hết nợ sẽ chuyển sang đây.' },
    deleteNameConfirm: (name, warn) => `Xóa toàn bộ lịch sử/sổ nợ mang tên "${name}" khỏi gợi ý.${warn} Các giao dịch chi tiêu đã ghi khi trả nợ trước đó vẫn được giữ nguyên. Không thể hoàn tác.`,
    api: {
      list: S.listCreditors, get: S.getCreditor, balance: S.creditorBalance, listNames: S.listCreditorNames, listEntries: S.listDebtEntries,
      total: S.totalDebtRemaining, addIncrease: S.addDebtCharge, addDecrease: S.addDebtPayment,
      updateEntry: S.updateDebtEntry, deleteEntry: S.deleteDebtEntry, updateCounterpart: S.updateCreditor, deleteByName: S.deleteCreditorsByName,
      counterpartIdKey: 'creditorId', counterpartNameKey: 'creditorName',
      increaseKind: 'charge', decreaseKind: 'payment',
    },
  },
  receivable: {
    tabLabel: 'Người khác nợ tôi',
    listIcon: 'trendingUp',
    totalLabel: 'Tổng sẽ thu về',
    totalColor: 'var(--color-primary-dark)',
    outstandingColor: 'var(--color-primary-dark)',
    settledColor: 'var(--success)',
    counterpartLabel: 'Người nợ', counterpartPlaceholder: 'VD: Anh Ba',
    renameTitle: 'Đổi tên người nợ',
    addBtnLabel: 'Cho vay mới',
    increaseModalTitle: 'Cho vay mới', increaseDetailBtn: 'Cho vay thêm',
    increaseDateLabel: 'Ngày cho vay', increaseDescLabel: 'Cho vay để làm gì (không bắt buộc)', increaseDescPlaceholder: 'VD: mượn tiền mặt, bán chịu hàng',
    increaseAmountLabel: 'Số tiền cho vay', increaseSubmitLabel: 'Cho vay',
    increaseTxnLabel: 'Tính là 1 khoản chi tiêu (tiền thật rời túi)', increaseTxnType: 'expense',
    increaseEntryLabel: 'Cho vay', increaseIcon: 'trendingUp',
    decreaseTitle: (name) => `Thu tiền — ${name}`, decreaseDetailBtn: 'Thu tiền',
    decreaseAmountLabel: 'Số tiền thu', decreaseDateLabel: 'Ngày thu', decreaseSubmitLabel: 'Xác nhận thu tiền',
    decreaseTxnLabel: 'Tính là 1 khoản thu nhập (tiền thật về túi)', decreaseTxnType: 'income',
    decreaseEntryLabel: 'Thu tiền', decreaseIcon: 'check',
    entryEditIncreaseTitle: 'Sửa khoản cho vay', entryEditDecreaseTitle: 'Sửa khoản thu',
    entryDetailIncreaseTitle: 'Dòng cho vay', entryDetailDecreaseTitle: 'Dòng thu tiền',
    entryDescLabel: 'Cho vay để làm gì',
    statusActiveTab: 'Còn nợ mình', statusPaidTab: 'Đã trả hết',
    statusActiveLabel: 'còn nợ mình', statusPaidLabel: 'đã trả hết',
    emptyActive: { title: 'Chưa có khoản cho vay nào', message: 'Bấm "Cho vay mới" để ghi lại khoản cho vay/bán chịu theo từng người.' },
    emptyPaid: { title: 'Chưa có ai trả hết', message: 'Người trả hết nợ sẽ chuyển sang đây.' },
    deleteNameConfirm: (name, warn) => `Xóa toàn bộ lịch sử/sổ mang tên "${name}" khỏi gợi ý.${warn} Các giao dịch thu/chi đã ghi trước đó vẫn được giữ nguyên. Không thể hoàn tác.`,
    api: {
      list: S.listDebtors, get: S.getDebtor, balance: S.debtorBalance, listNames: S.listDebtorNames, listEntries: S.listReceivableEntries,
      total: S.totalReceivable, addIncrease: S.addReceivableLend, addDecrease: S.addReceivableCollect,
      updateEntry: S.updateReceivableEntry, deleteEntry: S.deleteReceivableEntry, updateCounterpart: S.updateDebtor, deleteByName: S.deleteDebtorsByName,
      counterpartIdKey: 'debtorId', counterpartNameKey: 'debtorName',
      increaseKind: 'lend', decreaseKind: 'collect',
    },
  },
};

let direction = 'owe';
let tab = 'active';

export function renderHeader(headerEl) {
  headerEl.innerHTML = pageHeader({ title: 'Công nợ' });
}

export function render(contentEl) {
  const cfg = DIRECTIONS[direction];
  const total = cfg.api.total();
  contentEl.innerHTML = `
    <div class="tabs mb-16">
      ${Object.entries(DIRECTIONS).map(([key, d]) => `<button data-dir="${key}" class="${direction === key ? 'active' : ''}">${d.tabLabel}</button>`).join('')}
    </div>
    <div class="card card-pad mb-16">
      <div class="oc-line"><span>${cfg.totalLabel}</span><b style="color:${cfg.totalColor}">${formatVND(total)}</b></div>
    </div>
    <div class="mb-16"><button class="btn btn-primary btn-block" id="btn-add">${icon('plus', 'icon-sm')} ${cfg.addBtnLabel}</button></div>
    <div class="tabs mb-16">
      <button data-tab="active" class="${tab === 'active' ? 'active' : ''}">${cfg.statusActiveTab}</button>
      <button data-tab="paid" class="${tab === 'paid' ? 'active' : ''}">${cfg.statusPaidTab}</button>
    </div>
    <div id="counterpart-list"></div>
  `;
  contentEl.querySelectorAll('[data-dir]').forEach((btn) => {
    btn.addEventListener('click', () => { direction = btn.dataset.dir; tab = 'active'; render(contentEl); });
  });
  contentEl.querySelector('#btn-add').addEventListener('click', () => openIncreaseForm(cfg));
  contentEl.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => { tab = btn.dataset.tab; render(contentEl); });
  });
  renderList(contentEl.querySelector('#counterpart-list'), cfg);
}

function renderList(listEl, cfg) {
  const list = cfg.api.list({ status: tab });
  listEl.innerHTML = list.length
    ? list.map((c) => counterpartCardHtml(c, cfg)).join('')
    : `<div class="card card-pad">${emptyState({
        iconName: cfg.listIcon,
        title: tab === 'active' ? cfg.emptyActive.title : cfg.emptyPaid.title,
        message: tab === 'active' ? cfg.emptyActive.message : cfg.emptyPaid.message,
      })}</div>`;
  listEl.querySelectorAll('[data-counterpart]').forEach((row) => {
    row.addEventListener('click', () => openCounterpartDetail(row.dataset.counterpart, cfg));
  });
}

function counterpartCardHtml(c, cfg) {
  return `
    <div class="card card-pad mb-16" data-counterpart="${c.id}" style="cursor:pointer">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-8">
          <div class="cat-icon" style="background:var(--color-primary)">${icon(cfg.listIcon, 'icon-sm')}</div>
          <div>
            <b>${c.name}</b>
            ${c.lastDate ? `<div class="text-sm text-muted">Gần nhất: ${formatDate(c.lastDate)}</div>` : ''}
          </div>
        </div>
        <div style="text-align:right">
          <div class="fw-700" style="color:${c.balance > 0 ? cfg.outstandingColor : cfg.settledColor}">${formatVND(c.balance)}</div>
          <div class="text-sm text-muted">${c.balance > 0 ? cfg.statusActiveLabel : cfg.statusPaidLabel}</div>
        </div>
      </div>
    </div>`;
}

function openCounterpartDetail(counterpartId, cfg) {
  const c = cfg.api.get(counterpartId);
  if (!c) return;
  const balance = cfg.api.balance(c.id);
  const entries = cfg.api.listEntries(c.id);
  openModal({
    title: c.name,
    bodyHtml: `
      <div class="oc-line mb-16"><span>${balance > 0 ? cfg.statusActiveLabel[0].toUpperCase() + cfg.statusActiveLabel.slice(1) : cfg.statusPaidLabel[0].toUpperCase() + cfg.statusPaidLabel.slice(1)}</span><b style="color:${balance > 0 ? cfg.outstandingColor : cfg.settledColor}">${formatVND(balance)}</b></div>
      ${entries.length ? `
        <div class="fw-700 text-sm mb-8">Sổ</div>
        ${entries.map((e) => entryRowHtml(e, cfg)).join('')}
      ` : `<p class="text-sm text-muted">Chưa có dòng nào trong sổ.</p>`}
    `,
    footHtml: `
      <button class="btn btn-primary btn-block" data-increase>${icon('plus', 'icon-sm')} ${cfg.increaseDetailBtn}</button>
      <button class="btn btn-outline btn-block" data-decrease style="margin-top:8px">${icon('check', 'icon-sm')} ${cfg.decreaseDetailBtn}</button>
      <button class="btn btn-outline btn-block" data-rename style="margin-top:8px">${icon('edit', 'icon-sm')} ${cfg.renameTitle}</button>
    `,
    onMount(sheet, closeFn) {
      sheet.querySelector('[data-increase]').addEventListener('click', () => { closeFn(); openIncreaseForm(cfg, { counterpartId: c.id, counterpartName: c.name }); });
      sheet.querySelector('[data-decrease]').addEventListener('click', () => { closeFn(); openDecreaseModal(cfg, c, balance); });
      sheet.querySelector('[data-rename]').addEventListener('click', () => { closeFn(); openRenameModal(cfg, c); });
      sheet.querySelectorAll('[data-entry]').forEach((row) => {
        row.addEventListener('click', () => { closeFn(); openEntryActions(cfg, entries.find((e) => e.id === row.dataset.entry), c); });
      });
    },
  });
}

function entryRowHtml(e, cfg) {
  const isIncrease = e.kind === cfg.api.increaseKind;
  const icn = isIncrease ? cfg.increaseIcon : cfg.decreaseIcon;
  const color = isIncrease ? cfg.outstandingColor : cfg.settledColor;
  const label = isIncrease ? (e.description || cfg.increaseEntryLabel) : (e.description || cfg.decreaseEntryLabel);
  return `
    <div class="list-row" data-entry="${e.id}" style="cursor:pointer">
      <div class="row-thumb" style="background:${color}">${icon(icn, 'icon-sm')}</div>
      <div class="row-main">
        <div class="row-title">${label}</div>
        <div class="row-sub">${formatDate(e.date)}${e.transactionId ? ' · đã tính vào thu/chi' : ''}</div>
      </div>
      <div class="row-end"><span class="amount" style="color:${color}">${isIncrease ? '+' : '-'}${formatVND(e.amount)}</span></div>
    </div>`;
}

function openEntryActions(cfg, e, c) {
  if (!e) return;
  const isIncrease = e.kind === cfg.api.increaseKind;
  openModal({
    title: isIncrease ? cfg.entryDetailIncreaseTitle : cfg.entryDetailDecreaseTitle,
    bodyHtml: `
      <div class="oc-line"><span>Ngày</span><b>${formatDate(e.date)}</b></div>
      ${e.description ? `<div class="oc-line"><span>${isIncrease ? cfg.entryDescLabel : 'Ghi chú'}</span><b>${e.description}</b></div>` : ''}
      <div class="oc-line"><span>Số tiền</span><b>${formatVND(e.amount)}</b></div>
      <div class="oc-line"><span>Đưa vào thu/chi</span><b>${e.transactionId ? 'Có' : 'Không'}</b></div>
      ${e.transactionId ? `<p class="text-sm text-muted mt-16">Dòng này có kèm 1 giao dịch thu/chi thật. Sửa/xóa sẽ đồng bộ luôn giao dịch đó.</p>` : ''}
    `,
    footHtml: `
      <button class="btn btn-outline btn-block" data-edit>${icon('edit', 'icon-sm')} Sửa</button>
      <button class="btn btn-danger-outline btn-block" data-del style="margin-top:8px">${icon('trash', 'icon-sm')} Xóa</button>
    `,
    onMount(sheet, closeFn) {
      sheet.querySelector('[data-edit]').addEventListener('click', () => { closeFn(); openEditEntryForm(cfg, e, c); });
      sheet.querySelector('[data-del]').addEventListener('click', () => {
        closeFn();
        confirmDialog({
          title: 'Xóa dòng này?',
          message: e.transactionId ? 'Giao dịch thu/chi thật đã tạo kèm dòng này cũng sẽ bị xóa. Không thể hoàn tác.' : 'Không thể hoàn tác.',
          confirmLabel: 'Xóa', danger: true,
          onConfirm: async () => {
            try { await cfg.api.deleteEntry(e.id); toast('Đã xóa', 'success'); openCounterpartDetail(c.id, cfg); }
            catch (err) { toast(err.message || 'Có lỗi xảy ra', 'error'); }
          },
        });
      });
    },
  });
}

function openEditEntryForm(cfg, e, c) {
  const isIncrease = e.kind === cfg.api.increaseKind;
  const txnType = isIncrease ? cfg.increaseTxnType : cfg.decreaseTxnType;
  const txnLabel = isIncrease ? cfg.increaseTxnLabel : cfg.decreaseTxnLabel;
  openModal({
    title: isIncrease ? cfg.entryEditIncreaseTitle : cfg.entryEditDecreaseTitle,
    bodyHtml: `
      <div class="field"><label>Ngày</label><input id="entry-date" type="date" value="${e.date}" required/></div>
      <div class="field"><label>${isIncrease ? cfg.entryDescLabel : 'Ghi chú (không bắt buộc)'}</label><input id="entry-desc" value="${(e.description || '').replace(/"/g, '&quot;')}"/></div>
      <div class="field"><label>Số tiền</label><input id="entry-amount" type="text" inputmode="numeric" value="${formatNumber(e.amount)}" required/></div>
      ${addToTxnFieldsHtml('entry', !!e.transactionId, txnType, txnLabel)}
      <div class="field-error" id="entry-error" style="display:none;margin-bottom:10px"></div>
    `,
    footHtml: `<button class="btn btn-primary btn-block" data-save>Lưu thay đổi</button>`,
    onMount(sheet, closeFn) {
      attachMoneyInput(sheet.querySelector('#entry-amount'));
      bindAddToTxnToggle(sheet, 'entry');
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        const date = sheet.querySelector('#entry-date').value;
        const description = sheet.querySelector('#entry-desc').value.trim();
        const amount = unformatMoney(sheet.querySelector('#entry-amount').value);
        const addToTransactions = sheet.querySelector('#entry-add-txn').checked;
        const categoryId = sheet.querySelector('#entry-cat').value;
        const errEl = sheet.querySelector('#entry-error');
        try {
          await cfg.api.updateEntry(e.id, { amount, date, description, categoryId, addToTransactions });
          toast('Đã lưu', 'success');
          closeFn();
          openCounterpartDetail(c.id, cfg);
        } catch (err) { errEl.textContent = err.message || 'Có lỗi xảy ra'; errEl.style.display = 'block'; }
      });
    },
  });
}

function openRenameModal(cfg, c) {
  openModal({
    title: cfg.renameTitle,
    bodyHtml: `
      <div class="field"><label>${cfg.counterpartLabel}</label><input id="counterpart-name" value="${c.name.replace(/"/g, '&quot;')}" required/></div>
      <div class="field"><label>Ghi chú (không bắt buộc)</label><input id="counterpart-note" value="${(c.note || '').replace(/"/g, '&quot;')}"/></div>
      <div class="field-error" id="counterpart-error" style="display:none;margin-bottom:10px"></div>
    `,
    footHtml: `<button class="btn btn-primary btn-block" data-save>Lưu thay đổi</button>`,
    onMount(sheet, closeFn) {
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        const name = sheet.querySelector('#counterpart-name').value.trim();
        const note = sheet.querySelector('#counterpart-note').value.trim();
        const errEl = sheet.querySelector('#counterpart-error');
        try {
          await cfg.api.updateCounterpart(c.id, { name, note });
          toast('Đã lưu', 'success');
          closeFn();
          openCounterpartDetail(c.id, cfg);
        } catch (err) { errEl.textContent = err.message || 'Có lỗi xảy ra'; errEl.style.display = 'block'; }
      });
    },
  });
}

/** Ô "Đưa vào thu/chi" dùng chung cho form ghi tăng/giảm/sửa dòng — mặc định KHÔNG tích, tích vào
 * mới tự tạo giao dịch thật + hiện thêm ô chọn danh mục (đúng loại thu/chi truyền vào categoryType).
 * idPrefix để tránh trùng id khi nhiều form trên cùng trang. */
function addToTxnFieldsHtml(idPrefix, checked, categoryType, label) {
  const catOptions = `<option value="">Không chọn</option>` + S.listCategories({ type: categoryType }).map((cat) => `<option value="${cat.id}">${cat.name}</option>`).join('');
  return `
    <label class="flex items-center gap-8 mb-16" style="cursor:pointer">
      <input type="checkbox" id="${idPrefix}-add-txn" ${checked ? 'checked' : ''}/>
      <span class="text-sm">${label}</span>
    </label>
    <div class="field" id="${idPrefix}-cat-field" style="display:${checked ? '' : 'none'}">
      <label>Danh mục (không bắt buộc)</label><select id="${idPrefix}-cat">${catOptions}</select>
    </div>`;
}
function bindAddToTxnToggle(sheet, idPrefix) {
  const cb = sheet.querySelector(`#${idPrefix}-add-txn`);
  const field = sheet.querySelector(`#${idPrefix}-cat-field`);
  cb.addEventListener('change', () => { field.style.display = cb.checked ? '' : 'none'; });
}

function openDecreaseModal(cfg, c, balance) {
  openModal({
    title: cfg.decreaseTitle(c.name),
    bodyHtml: `
      <p class="text-sm text-muted mb-16">${cfg.statusActiveLabel[0].toUpperCase() + cfg.statusActiveLabel.slice(1)}: <b>${formatVND(balance)}</b></p>
      <div class="field"><label>${cfg.decreaseAmountLabel}</label><input id="pay-amount" type="text" inputmode="numeric" value="${formatNumber(Math.max(0, balance))}"/></div>
      <div class="field"><label>${cfg.decreaseDateLabel}</label><input id="pay-date" type="date" value="${new Date().toISOString().slice(0, 10)}"/></div>
      ${addToTxnFieldsHtml('pay', false, cfg.decreaseTxnType, cfg.decreaseTxnLabel)}
      <div class="field-error" id="pay-error" style="display:none;margin-bottom:10px"></div>
    `,
    footHtml: `<button class="btn btn-primary btn-block" data-ok>${cfg.decreaseSubmitLabel}</button>`,
    onMount(sheet, closeFn) {
      attachMoneyInput(sheet.querySelector('#pay-amount'));
      bindAddToTxnToggle(sheet, 'pay');
      sheet.querySelector('[data-ok]').addEventListener('click', async () => {
        const amount = unformatMoney(sheet.querySelector('#pay-amount').value);
        const date = sheet.querySelector('#pay-date').value;
        const addToTransactions = sheet.querySelector('#pay-add-txn').checked;
        const categoryId = sheet.querySelector('#pay-cat').value;
        const errEl = sheet.querySelector('#pay-error');
        try {
          await cfg.api.addDecrease(c.id, { amount, date, categoryId, addToTransactions });
          toast(`Đã ${cfg.decreaseEntryLabel.toLowerCase()}`, 'success');
          closeFn();
          openCounterpartDetail(c.id, cfg);
        } catch (err) { errEl.textContent = err.message || 'Có lỗi xảy ra'; errEl.style.display = 'block'; }
      });
    },
  });
}

/** Gợi ý tên đã dùng qua (kể cả đã "đã trả hết" — vẫn giữ tên để chọn lại lần sau), chỉ hiện TÊN cho
 * gọn, không hiện số tiền. CHỈ xổ ra khi bấm nút mũi tên bên cạnh (không tự bung lúc gõ, đỡ dài
 * dòng) — gõ tên mới hoàn toàn thì cứ gõ, không cần bấm gì. */
function bindCounterpartNameSuggestions(cfg, sheet, inputId, listId, toggleId) {
  const input = sheet.querySelector(`#${inputId}`);
  const list = sheet.querySelector(`#${listId}`);
  const toggle = sheet.querySelector(`#${toggleId}`);
  function render() {
    // Đọc lại cfg.api.listNames() mỗi lần render (không lưu 1 lần) để danh sách cập nhật ngay sau
    // khi xóa 1 tên, không cần đóng/mở lại.
    const allNames = cfg.api.listNames();
    const q = input.value.trim().toLowerCase();
    const matches = q ? allNames.filter((n) => n.toLowerCase().includes(q) && n.toLowerCase() !== q) : allNames;
    list.innerHTML = matches.length
      ? matches.map((n) => {
          const esc = n.replace(/"/g, '&quot;');
          return `
            <div style="display:flex;align-items:center;border-bottom:1px solid var(--border)">
              <span data-name="${esc}" style="flex:1;padding:8px 12px;cursor:pointer;font-size:14px">${n}</span>
              <button type="button" data-del-name="${esc}" aria-label="Xóa tên ${esc}" style="padding:8px 12px;background:none;border:none;color:var(--text-muted);cursor:pointer">${icon('x', 'icon-sm')}</button>
            </div>`;
        }).join('')
      : `<div style="padding:8px 12px;font-size:14px;color:var(--text-muted)">Chưa có tên nào</div>`;
  }
  function close() { list.style.display = 'none'; }
  function open() { render(); list.style.display = ''; }
  toggle.addEventListener('mousedown', (e) => e.preventDefault());
  toggle.addEventListener('click', () => { if (list.style.display === 'none') open(); else close(); });
  input.addEventListener('input', () => { if (list.style.display !== 'none') render(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-del-name]');
    if (delBtn) {
      const name = delBtn.dataset.delName;
      const matches = cfg.api.list().filter((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
      const owing = matches.filter((c) => c.balance > 0).reduce((s, c) => s + c.balance, 0);
      const warn = owing > 0 ? ` Trong đó có sổ đang ${cfg.statusActiveLabel} ${formatVND(owing)} — xóa sẽ MẤT LUÔN sổ đang mở này.` : '';
      confirmDialog({
        title: `Xóa tên ${cfg.counterpartLabel.toLowerCase()} này?`,
        message: cfg.deleteNameConfirm(name, warn),
        confirmLabel: 'Xóa', danger: true,
        onConfirm: async () => {
          try { await cfg.api.deleteByName(name); toast(`Đã xóa tên ${cfg.counterpartLabel.toLowerCase()}`, 'success'); render(); }
          catch (err) { toast(err.message || 'Có lỗi xảy ra', 'error'); }
        },
      });
      return;
    }
    const item = e.target.closest('[data-name]');
    if (!item) return;
    input.value = item.dataset.name;
    close();
  });
}

function openIncreaseForm(cfg, { counterpartId, counterpartName } = {}) {
  const locked = !!counterpartId;
  openModal({
    title: cfg.increaseModalTitle,
    bodyHtml: `
      <div class="field" style="position:relative">
        <label>${cfg.counterpartLabel}</label>
        ${locked
          ? `<input id="incr-counterpart-name" value="${counterpartName.replace(/"/g, '&quot;')}" readonly/>`
          : `<div class="flex items-center gap-8">
              <input id="incr-counterpart-name" placeholder="${cfg.counterpartPlaceholder}" autocomplete="off" style="flex:1"/>
              <button type="button" class="icon-btn" id="incr-counterpart-toggle" aria-label="Chọn tên đã dùng">${icon('chevronDown', 'icon-sm')}</button>
            </div>
            <div id="incr-counterpart-list" style="display:none;position:absolute;left:0;right:0;z-index:5;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-top:4px;max-height:160px;overflow-y:auto"></div>`}
      </div>
      <div class="field"><label>${cfg.increaseDateLabel}</label><input id="incr-date" type="date" value="${new Date().toISOString().slice(0, 10)}" required/></div>
      <div class="field"><label>${cfg.increaseDescLabel}</label><input id="incr-desc" placeholder="${cfg.increaseDescPlaceholder}"/></div>
      <div class="field"><label>${cfg.increaseAmountLabel}</label><input id="incr-amount" type="text" inputmode="numeric" required/></div>
      ${addToTxnFieldsHtml('incr', false, cfg.increaseTxnType, cfg.increaseTxnLabel)}
      <div class="field-error" id="incr-error" style="display:none;margin-bottom:10px"></div>
    `,
    footHtml: `<button class="btn btn-primary btn-block" data-save>${cfg.increaseSubmitLabel}</button>`,
    onMount(sheet, closeFn) {
      attachMoneyInput(sheet.querySelector('#incr-amount'));
      bindAddToTxnToggle(sheet, 'incr');
      if (!locked) bindCounterpartNameSuggestions(cfg, sheet, 'incr-counterpart-name', 'incr-counterpart-list', 'incr-counterpart-toggle');
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        const nameVal = locked ? counterpartName : sheet.querySelector('#incr-counterpart-name').value.trim();
        const date = sheet.querySelector('#incr-date').value;
        const description = sheet.querySelector('#incr-desc').value.trim();
        const amount = unformatMoney(sheet.querySelector('#incr-amount').value);
        const addToTransactions = sheet.querySelector('#incr-add-txn').checked;
        const categoryId = sheet.querySelector('#incr-cat').value;
        const errEl = sheet.querySelector('#incr-error');
        if (!nameVal) { errEl.textContent = `Cần nhập tên ${cfg.counterpartLabel.toLowerCase()}.`; errEl.style.display = 'block'; return; }
        const payload = {
          [cfg.api.counterpartIdKey]: locked ? counterpartId : undefined,
          [cfg.api.counterpartNameKey]: locked ? undefined : nameVal,
          amount, date, description, categoryId, addToTransactions,
        };
        try {
          await cfg.api.addIncrease(payload);
          toast(`Đã ${cfg.increaseSubmitLabel.toLowerCase()}`, 'success');
          closeFn();
          if (locked) openCounterpartDetail(counterpartId, cfg);
        } catch (err) { errEl.textContent = err.message || 'Có lỗi xảy ra'; errEl.style.display = 'block'; }
      });
    },
  });
}
