import * as S from '../state.js';
import { openModal } from './modal.js';
import { escapeHtml, formatVND } from '../utils.js';
import { toast } from './toast.js';

export function updateRecoveryBanner() {
  let banner = document.getElementById('sync-recovery-banner');
  const rows = S.listRecoverableTransactions();
  if (!rows.length) { banner?.remove(); return; }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'sync-recovery-banner';
    banner.className = 'sync-banner';
    document.getElementById('sync-banner')?.after(banner);
  }
  banner.replaceChildren(document.createTextNode(`${rows.length} giao dịch từ bản cũ chỉ có trên máy này. `));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-outline';
  button.textContent = 'Kiểm tra và khôi phục';
  banner.append(button);
  button.addEventListener('click', () => openModal({
    title: 'Giao dịch chưa có trên máy chủ',
    bodyHtml: `<p>Chọn các khoản cần gửi lên sổ chung. Bỏ chọn khoản đã chủ động xóa trên thiết bị khác.</p>
      ${rows.map((row, index) => `<label class="list-row"><input type="checkbox" name="recovery" value="${index}"/>
        <span>${escapeHtml(row.date)} · ${escapeHtml(row.note || 'Không có ghi chú')} · ${formatVND(row.amount)}</span></label>`).join('')}`,
    footHtml: '<button class="btn btn-primary" data-restore>Khôi phục các khoản đã chọn</button>',
    onMount(root, close) {
      root.querySelector('[data-restore]').addEventListener('click', async (event) => {
        const ids = [...root.querySelectorAll('input[name="recovery"]:checked')].map((input) => rows[Number(input.value)].id);
        if (!ids.length) return;
        event.target.disabled = true;
        try {
          await S.recoverTransactions(ids);
          close();
          toast(S.pendingSyncCount() ? 'Đã lưu để đồng bộ. Xem trạng thái ở đầu trang.' : 'Đã khôi phục lên sổ chung.', 'success');
        } catch (error) { toast(error.message, 'error'); event.target.disabled = false; }
      });
    },
  }));
}
