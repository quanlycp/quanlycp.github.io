import * as S from '../state.js';
import { pageHeader } from '../components/shell.js';
import { toast } from '../components/toast.js';

export function renderHeader(headerEl) {
  headerEl.innerHTML = pageHeader({ title: 'Cài đặt' });
}

export function render(contentEl) {
  const settings = S.getSettings();
  contentEl.innerHTML = `
    <div class="card card-pad">
      <div class="section-head"><h2>Thông tin sổ chi tiêu</h2></div>
      <form id="settings-form">
        <div class="field"><label>Tên sổ</label><input name="householdName" value="${esc(settings.householdName)}" required/></div>
        <div class="field"><label>Đơn vị tiền tệ</label><input name="currency" value="${esc(settings.currency)}" maxlength="6" style="max-width:120px"/></div>
        <button class="btn btn-primary btn-block" type="submit">Lưu thay đổi</button>
      </form>
    </div>
  `;
  contentEl.querySelector('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await S.updateSettings({ householdName: fd.get('householdName'), currency: fd.get('currency') });
      toast('Đã lưu cài đặt', 'success');
    } catch (err) { toast(err.message || 'Có lỗi xảy ra', 'error'); }
  });
}
function esc(s) { return String(s || '').replace(/"/g, '&quot;'); }
