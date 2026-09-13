// Nhật ký hoạt động — CHỈ chủ sổ thấy (xem NAV_OWNER_ONLY ở components/shell.js), phục vụ rà soát
// của Trưởng ban kiểm soát: ai Thêm/Sửa/Xóa giao dịch nào, lúc nào. Dữ liệu tự ghi bằng trigger ở
// Supabase (xem docs/expense-app-setup.md mục 14) — trang này chỉ đọc và hiển thị, không tự ghi gì.
//
// Hiển thị: gom nhóm theo NGÀY thao tác — ngày hiện 1 LẦN DUY NHẤT làm tiêu đề nhóm (không lặp lại
// trong từng dòng), mỗi dòng bên dưới hiện đầy đủ giờ + tài khoản + hành động + toàn bộ nội dung/
// ngày giao dịch — không dùng .list-row/.row-title (bị cắt bớt bằng "..." nếu dài, kiểu dùng cho
// danh sách gọn) mà tự dựng khối riêng, chữ tự xuống dòng, không mất chữ nào.
import * as S from '../state.js';
import { icon } from '../icons.js';
import { pageHeader } from '../components/shell.js';
import { emptyState } from '../components/ui.js';
import { formatVND, formatDate } from '../utils.js';

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
  if (!rows.length) {
    contentEl.innerHTML = `<div class="card card-pad">${emptyState({
      iconName: 'clock', title: 'Chưa có gì trong nhật ký', message: 'Mọi lượt thêm/sửa/xóa giao dịch của mọi thành viên sẽ tự ghi lại ở đây.',
    })}</div>`;
    return;
  }
  contentEl.innerHTML = `
    <p class="text-sm text-muted mb-16">Tự động ghi lại mọi lượt Thêm/Sửa/Xóa giao dịch — 200 dòng gần nhất, mới nhất ở trên.</p>
    ${groupByDay(rows).map(groupHtml).join('')}
  `;
}

/** Gom các dòng cùng NGÀY thao tác (theo giờ máy người xem, không phải UTC) lại 1 nhóm, giữ nguyên
 * thứ tự mới nhất trước (rows vào đây đã sắp xếp sẵn theo created_at desc). */
function groupByDay(rows) {
  const groups = [];
  let current = null;
  for (const r of rows) {
    const dayKey = r.createdAt ? formatDate(r.createdAt) : 'Không rõ ngày';
    if (!current || current.dayKey !== dayKey) {
      current = { dayKey, items: [] };
      groups.push(current);
    }
    current.items.push(r);
  }
  return groups;
}

function groupHtml(group) {
  return `
    <div class="mb-16">
      <div class="fw-700 text-sm mb-8">${group.dayKey}</div>
      ${group.items.map(entryHtml).join('')}
    </div>`;
}

function entryHtml(r) {
  const label = ACTION_LABEL[r.action] || r.action;
  const color = ACTION_COLOR[r.action] || 'var(--text-muted)';
  const timeStr = r.createdAt ? new Date(r.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
  return `
    <div class="card card-pad mb-8">
      <div class="flex items-center justify-between mb-8" style="gap:8px">
        <div class="flex items-center gap-8" style="min-width:0">
          <div class="row-thumb" style="background:${color};flex-shrink:0">${icon(ACTION_ICON[r.action] || 'clock', 'icon-sm')}</div>
          <b style="color:${color}">${label}</b>
          <span class="text-sm" style="word-break:break-word">— ${r.userName}</span>
        </div>
        <span class="text-sm text-muted" style="flex-shrink:0">${timeStr}</span>
      </div>
      <div class="text-sm" style="word-break:break-word;white-space:pre-wrap">${r.txnNote || '(không ghi chú)'}</div>
      <div class="text-sm text-muted mt-4">
        ${r.txnCategoryName ? r.txnCategoryName + ' · ' : ''}${r.txnDate ? 'Ngày giao dịch: ' + formatDate(r.txnDate) : ''}
      </div>
      <div class="fw-700 mt-4" style="color:${color}">${formatVND(r.txnAmount)}</div>
    </div>`;
}
