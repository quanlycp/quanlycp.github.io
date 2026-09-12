// Nhật ký hoạt động — CHỈ chủ sổ thấy (xem NAV_OWNER_ONLY ở components/shell.js), phục vụ rà soát
// của Trưởng ban kiểm soát: ai Thêm/Sửa/Xóa giao dịch nào, lúc nào. Dữ liệu tự ghi bằng trigger ở
// Supabase (xem docs/expense-app-setup.md mục 14) — trang này chỉ đọc và hiển thị, không tự ghi gì.
import * as S from '../state.js';
import { icon } from '../icons.js';
import { pageHeader } from '../components/shell.js';
import { emptyState } from '../components/ui.js';
import { formatVND, formatDate, formatDateTime } from '../utils.js';

export function renderHeader(headerEl) {
  headerEl.innerHTML = pageHeader({ title: 'Nhật ký' });
}

const ACTION_LABEL = { INSERT: 'Thêm', UPDATE: 'Sửa', DELETE: 'Xóa' };
const ACTION_COLOR = { INSERT: 'var(--success)', UPDATE: 'var(--color-primary)', DELETE: 'var(--danger)' };
const ACTION_ICON = { INSERT: 'plus', UPDATE: 'edit', DELETE: 'trash' };

export async function render(contentEl) {
  contentEl.innerHTML = `<p class="text-sm text-muted">Đang tải nhật ký...</p>`;
  let rows;
  try {
    rows = await S.fetchActivityLog();
  } catch (err) {
    contentEl.innerHTML = `<div class="card card-pad"><p class="text-sm text-muted">${err.message || 'Không tải được nhật ký, thử lại sau.'}</p></div>`;
    return;
  }
  contentEl.innerHTML = `
    <p class="text-sm text-muted mb-16">Tự động ghi lại mọi lượt Thêm/Sửa/Xóa giao dịch — 200 dòng gần nhất, mới nhất ở trên.</p>
    ${rows.length ? `<div class="card">${rows.map(rowHtml).join('')}</div>` : `<div class="card card-pad">${emptyState({
      iconName: 'clock', title: 'Chưa có gì trong nhật ký', message: 'Mọi lượt thêm/sửa/xóa giao dịch của mọi thành viên sẽ tự ghi lại ở đây.',
    })}</div>`}
  `;
}

function rowHtml(r) {
  const label = ACTION_LABEL[r.action] || r.action;
  const color = ACTION_COLOR[r.action] || 'var(--text-muted)';
  return `
    <div class="list-row">
      <div class="row-thumb" style="background:${color}">${icon(ACTION_ICON[r.action] || 'clock', 'icon-sm')}</div>
      <div class="row-main">
        <div class="row-title">${label} · ${r.userName}${r.txnCategoryName ? ' · ' + r.txnCategoryName : ''}</div>
        <div class="row-sub">${r.txnNote || '(không ghi chú)'}${r.txnDate ? ' · ' + formatDate(r.txnDate) : ''}</div>
      </div>
      <div class="row-end" style="text-align:right">
        <div class="amount" style="color:${color}">${formatVND(r.txnAmount)}</div>
        <div class="text-sm text-muted">${formatDateTime(r.createdAt)}</div>
      </div>
    </div>`;
}
