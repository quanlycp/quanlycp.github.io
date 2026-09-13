// Form thêm/sửa giao dịch (thu/chi) — dùng chung cho Dashboard (FAB), trang
// Giao dịch, và khi xác nhận 1 khoản định kỳ. Gom vào 1 chỗ để 3 nơi gọi
// khác nhau không phải chép lại y hệt nhau.
//
// Chọn đúng 2 danh mục HỆ THỐNG "Mượn nợ" (khoản thu) / "Trả nợ" (khoản chi)
// — xem state.js SPECIAL_CATEGORIES — sẽ tự hiện thêm các ô liên quan tới
// Công nợ ngay trong form này, khỏi phải tự vào tay trang Công nợ ghi lại lần
// nữa (xem docs/expense-app-setup.md mục 12). Chỉ áp dụng khi THÊM MỚI —
// sửa 1 giao dịch có sẵn thì sửa như giao dịch thường (amount/danh mục/ngày/
// ghi chú), không đụng lại tới việc tạo/đồng bộ sổ nợ, tránh tạo trùng dòng.
import * as S from '../state.js';
import { icon } from '../icons.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { formatNumber, formatVND, attachMoneyInput, unformatMoney } from '../utils.js';

/**
 * opts: { transaction? (sửa nếu có), defaultType?, onSaved? }
 */
export function openTransactionForm({ transaction, defaultType = 'expense', onSaved } = {}) {
  let type = transaction ? transaction.type : defaultType;
  const isAddMode = !transaction;

  function categoryOptionsHtml() {
    return S.listCategories({ type }).map((c) => `<option value="${c.id}" ${transaction?.categoryId === c.id ? 'selected' : ''}>${c.name}</option>`).join('');
  }

  const close = openModal({
    title: transaction ? 'Sửa giao dịch' : 'Thêm giao dịch',
    bodyHtml: `
      <div class="tabs mb-16">
        <button type="button" data-type="expense" class="${type === 'expense' ? 'active' : ''}">Khoản chi</button>
        <button type="button" data-type="income" class="${type === 'income' ? 'active' : ''}">Khoản thu</button>
      </div>
      <form id="txn-form">
        <div class="field">
          <label>Số tiền</label>
          <input name="amount" id="txn-amount" type="text" inputmode="numeric" required value="${transaction ? formatNumber(transaction.amount) : ''}" placeholder="0"/>
        </div>
        <div class="field">
          <label>Danh mục</label>
          <select name="categoryId" id="txn-cat-select" required>${categoryOptionsHtml()}</select>
        </div>
        <div id="txn-debt-fields"></div>
        <div class="field">
          <label>Ngày</label>
          <input name="date" type="date" required value="${transaction ? transaction.date : new Date().toISOString().slice(0, 10)}"/>
        </div>
        <div class="field">
          <label>Ghi chú</label>
          <input name="note" value="${transaction ? (transaction.note || '').replace(/"/g, '&quot;') : ''}" placeholder="Không bắt buộc"/>
        </div>
        <div class="field-error" id="txn-error" style="display:none;margin-bottom:10px"></div>
        <button class="btn btn-primary btn-block" type="submit">${icon('check', 'icon-sm')} ${transaction ? 'Lưu thay đổi' : 'Thêm giao dịch'}</button>
      </form>
    `,
    onMount(sheet) {
      const form = sheet.querySelector('#txn-form');
      const catSelect = sheet.querySelector('#txn-cat-select');
      const debtFieldsEl = sheet.querySelector('#txn-debt-fields');
      attachMoneyInput(sheet.querySelector('#txn-amount'));

      function renderDebtFields() {
        if (!isAddMode) { debtFieldsEl.innerHTML = ''; return; }
        const category = S.getCategory(catSelect.value);
        if (category?.special === 'borrow') debtFieldsEl.innerHTML = borrowFieldsHtml();
        else if (category?.special === 'repay') debtFieldsEl.innerHTML = repayFieldsHtml();
        else { debtFieldsEl.innerHTML = ''; return; }
        bindDebtFieldEvents(debtFieldsEl);
      }

      sheet.querySelectorAll('[data-type]').forEach((btn) => {
        btn.addEventListener('click', () => {
          type = btn.dataset.type;
          sheet.querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('active', b === btn));
          catSelect.innerHTML = categoryOptionsHtml();
          renderDebtFields();
        });
      });
      catSelect.addEventListener('change', renderDebtFields);
      renderDebtFields();

      if (!S.listCategories({ type }).length) {
        sheet.querySelector('#txn-error').style.display = 'block';
        sheet.querySelector('#txn-error').textContent = 'Chưa có danh mục nào — tạo danh mục trước ở trang Danh mục.';
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const categoryId = fd.get('categoryId');
        const category = S.getCategory(categoryId);
        const amount = unformatMoney(fd.get('amount'));
        const date = fd.get('date');
        const note = fd.get('note');
        const errEl = sheet.querySelector('#txn-error');
        const btn = form.querySelector('button[type="submit"]');
        errEl.style.display = 'none';
        btn.disabled = true;
        try {
          let mirrorResult = null;
          if (isAddMode && category?.special === 'borrow') {
            mirrorResult = await submitBorrow(sheet, { amount, date, description: note, categoryId });
          } else if (isAddMode && category?.special === 'repay') {
            mirrorResult = await submitRepay(sheet, { amount, date, description: note, categoryId });
          } else if (transaction) {
            await S.updateTransaction(transaction.id, { type, amount, categoryId, date, note });
          } else {
            await S.addTransaction({ type, amount, categoryId, date, note });
          }
          toast(transaction ? 'Đã lưu thay đổi' : 'Đã thêm giao dịch', 'success');
          close();
          onSaved && onSaved();
          // Bước "điền hộ" sang sổ riêng của thành viên (mirror) chạy NỀN, không chặn đóng form ở
          // trên (xem S.addDebtCharge/addDebtPayment) — chờ riêng ở đây rồi mới báo nếu nó thất bại,
          // đừng để im lặng tưởng nhầm app lỗi khác. Form đã đóng nên toast này có thể hiện trễ hơn
          // 1 chút sau khi người dùng đã rời màn — không sao, toast không phụ thuộc form còn mở hay không.
          // Mất mạng lúc này KHÔNG còn là thất bại hẳn — bước điền hộ tự xếp hàng và tự làm lại khi có
          // mạng (xem state.pendingMirrors/processPendingMirrors trong state.js), chỉ báo cho biết.
          if (mirrorResult?.mirrorPromise) {
            mirrorResult.mirrorPromise.then((r) => {
              if (r?.offline) {
                toast('Đang mất mạng — đã ghi vào Nợ chung, sẽ TỰ điền sang sổ riêng của thành viên đó khi có mạng lại, không cần làm tay.', 'default');
              } else if (r?.mirrorFailed) {
                toast('Đã ghi vào Nợ chung, nhưng CHƯA điền/đồng bộ được vào sổ riêng của thành viên đó — kiểm tra lại đã chạy đủ SQL/deploy Edge Function mới chưa (xem docs mục 13).', 'error');
              } else if (r?.mirrorOk) {
                // Báo THÀNH CÔNG rõ ràng (trước đây thành công thì im lặng hoàn toàn) — để biết chắc
                // bước điền hộ CÓ chạy và CÓ được Edge Function xác nhận "ok", không phải đoán mò.
                toast('Đã tự điền sang sổ riêng "Người khác nợ tôi" của thành viên đó.', 'success');
              }
            });
          }
        } catch (err) {
          errEl.textContent = err.message || 'Có lỗi xảy ra, thử lại sau.';
          errEl.style.display = 'block';
        } finally {
          btn.disabled = false;
        }
      });
    },
  });
  return close;
}

// ------------------------------------------------------------
// Ô bổ sung khi chọn danh mục "Mượn nợ" (khoản thu)
// ------------------------------------------------------------
function borrowFieldsHtml() {
  // Liệt kê TẤT CẢ user trong sổ (kể cả chính mình) — vì khoản này luôn vào Nợ chung, ai xem/sửa
  // cũng như nhau, không cần loại người đang đăng nhập ra khỏi danh sách chọn.
  const members = S.listMembers();
  return `
    <div class="card card-pad mb-16" style="background:var(--surface-alt);border-color:transparent">
      ${members.length ? `
      <div class="tabs-sm mb-12">
        <button type="button" data-counterpart-type="external" class="active">Người ngoài</button>
        <button type="button" data-counterpart-type="member">Thành viên trong sổ</button>
      </div>` : ''}
      <div class="field" id="debt-external-field" style="margin-bottom:${members.length ? '16px' : '14px'}">
        <label>Mượn của ai</label>
        <input id="debt-creditor-name" placeholder="VD: Tạp hóa A, Anh Ba" autocomplete="off"/>
      </div>
      ${members.length ? `
      <div class="field" id="debt-member-field" style="display:none">
        <label>Mượn của thành viên nào</label>
        <select id="debt-member-select">${members.map((u) => `<option value="${u.id}">${u.name}</option>`).join('')}</select>
      </div>` : ''}
      <p class="text-sm text-muted" style="margin:0">Tự ghi vào <b>Công nợ → Nợ chung</b> — mọi thành viên đều xem/sửa được.</p>
    </div>
  `;
}

// ------------------------------------------------------------
// Ô bổ sung khi chọn danh mục "Trả nợ" (khoản chi) — mục này CHỈ có Nợ chung (không còn khoản
// riêng tư nào tạo được từ đây nữa từ khi "Mượn nợ" luôn luôn vào Nợ chung), nên khỏi cần ghi
// thêm "[Nợ chung]" trước tên cho rối.
// ------------------------------------------------------------
function repayFieldsHtml() {
  const sharedDebts = S.listCreditors({ status: 'active', shared: true });
  const optionsHtml = sharedDebts.map((c) => `<option value="${c.id}" data-balance="${c.balance}">${c.name} — còn ${formatVND(c.balance)}</option>`).join('');
  return `
    <div class="field">
      <label>Trả cho khoản nợ nào</label>
      <select id="debt-repay-select">
        <option value="">Trả khoản nợ khác (không theo dõi trong Công nợ)</option>
        ${optionsHtml}
      </select>
      <div class="field-hint" id="debt-repay-hint" style="display:none"></div>
      ${!sharedDebts.length ? `<div class="field-hint">Chưa có khoản Nợ chung nào đang theo dõi — chọn "Mượn nợ" ở khoản thu trước, hoặc cứ ghi khoản chi này bình thường.</div>` : ''}
    </div>
  `;
}

function bindDebtFieldEvents(container) {
  const tabs = container.querySelectorAll('[data-counterpart-type]');
  if (tabs.length) {
    const externalField = container.querySelector('#debt-external-field');
    const memberField = container.querySelector('#debt-member-field');
    tabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        tabs.forEach((b) => b.classList.toggle('active', b === btn));
        const isMember = btn.dataset.counterpartType === 'member';
        externalField.style.display = isMember ? 'none' : '';
        memberField.style.display = isMember ? '' : 'none';
      });
    });
  }
  // Chọn khoản nợ để trả -> nhắc rõ số còn nợ, không cho nhập quá số này (chặn thật ở submitRepay).
  const repaySelect = container.querySelector('#debt-repay-select');
  if (repaySelect) {
    const hint = container.querySelector('#debt-repay-hint');
    function syncHint() {
      const opt = repaySelect.selectedOptions[0];
      if (opt && opt.value) {
        hint.textContent = `Nợ còn ${formatVND(Number(opt.dataset.balance))} — không nhập số tiền vượt quá số này.`;
        hint.style.display = '';
      } else {
        hint.style.display = 'none';
      }
    }
    repaySelect.addEventListener('change', syncHint);
    syncHint();
  }
}

/** Ghi "Mượn nợ" từ ô bổ sung trong form Thêm giao dịch — LUÔN LUÔN vào Nợ chung (mọi thành viên
 * cùng xem/sửa), chủ nợ là người ngoài (gõ tên) hoặc 1 thành viên trong sổ (chỉ để tiện chọn tên có
 * sẵn, không cần gõ tay — không có gì phải "riêng tư" ở đây nên khỏi cần hỏi thêm). */
async function submitBorrow(sheet, { amount, date, description, categoryId }) {
  const activeTab = sheet.querySelector('[data-counterpart-type].active');
  const counterpartType = activeTab ? activeTab.dataset.counterpartType : 'external';
  if (counterpartType === 'member') {
    const memberUserId = sheet.querySelector('#debt-member-select').value;
    if (!memberUserId) throw new Error('Cần chọn thành viên.');
    return await S.addDebtCharge({ memberUserId, shared: true, amount, date, description, categoryId, addToTransactions: true });
  } else {
    const name = sheet.querySelector('#debt-creditor-name').value.trim();
    if (!name) throw new Error('Cần nhập tên chủ nợ.');
    return await S.addDebtCharge({ creditorName: name, shared: true, amount, date, description, categoryId, addToTransactions: true });
  }
}

/** Ghi "Trả nợ" từ ô bổ sung trong form Thêm giao dịch — trừ vào đúng khoản nợ đã chọn (Nợ chung,
 * hoặc 1 khoản riêng tư cũ đã ghi từ trang Công nợ), hoặc chỉ ghi 1 khoản chi thường nếu chọn "Trả
 * khoản nợ khác (không theo dõi)". */
async function submitRepay(sheet, { amount, date, description, categoryId }) {
  const select = sheet.querySelector('#debt-repay-select');
  const creditorId = select.value;
  if (!creditorId) {
    await S.addTransaction({ type: 'expense', amount, categoryId, date, note: description });
    return;
  }
  const balance = Number(select.selectedOptions[0].dataset.balance);
  if (amount > balance) throw new Error(`Số tiền trả không được vượt quá nợ còn lại (${formatVND(balance)}).`);
  return await S.addDebtPayment(creditorId, { amount, date, description, categoryId, addToTransactions: true });
}
