import * as S from '../state.js';
import { pageHeader } from '../components/shell.js';
import { toast } from '../components/toast.js';

/** Màn tự đổi tên hiển thị + mật khẩu (tự chọn, dùng bất cứ lúc nào) — dùng chung cho owner lẫn member. */
export function renderHeader(headerEl) {
  headerEl.innerHTML = pageHeader({ title: 'Đổi mật khẩu' });
}

export function render(contentEl) {
  const session = S.getSession();
  const me = S.getUser(session?.id);
  contentEl.innerHTML = `
    <div class="card card-pad mb-16" style="max-width:420px">
      <p class="text-sm text-muted mb-16">Tên hiển thị của bạn ở khắp nơi trong app (giao dịch bạn ghi, chọn làm chủ nợ/người nợ...).</p>
      <form id="self-name-form">
        <div class="field">
          <label>Tên hiển thị</label>
          <input name="name" value="${(me?.name || '').replace(/"/g, '&quot;')}" required/>
        </div>
        <div class="field-error" id="self-name-error" style="display:none;margin-bottom:10px"></div>
        <button class="btn btn-outline btn-block" type="submit">Lưu tên hiển thị</button>
      </form>
    </div>
    <div class="card card-pad" style="max-width:420px">
      <p class="text-sm text-muted mb-16">Đặt mật khẩu mới cho tài khoản của bạn. Cần nhập đúng mật khẩu hiện tại để xác nhận.</p>
      <form id="self-pw-form">
        <div class="field">
          <label>Mật khẩu hiện tại</label>
          <input name="pwOld" type="password" required autocomplete="current-password"/>
        </div>
        <div class="field">
          <label>Mật khẩu mới</label>
          <input name="pw1" type="password" required minlength="6" autocomplete="new-password" placeholder="Tối thiểu 6 ký tự"/>
        </div>
        <div class="field">
          <label>Nhập lại mật khẩu mới</label>
          <input name="pw2" type="password" required minlength="6" autocomplete="new-password"/>
        </div>
        <div class="field-error" id="self-pw-error" style="display:none;margin-bottom:10px"></div>
        <button class="btn btn-primary btn-block" type="submit">Xác nhận đổi mật khẩu</button>
      </form>
    </div>
  `;

  contentEl.querySelector('#self-name-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').toString().trim();
    const errEl = contentEl.querySelector('#self-name-error');
    errEl.style.display = 'none';
    try {
      await S.setOwnName(name);
      toast('Đã lưu tên hiển thị', 'success');
    } catch (err) { errEl.textContent = err.message || 'Có lỗi xảy ra, thử lại sau.'; errEl.style.display = 'block'; }
  });

  contentEl.querySelector('#self-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const pwOld = fd.get('pwOld'), pw1 = fd.get('pw1'), pw2 = fd.get('pw2');
    const errEl = contentEl.querySelector('#self-pw-error');
    errEl.style.display = 'none';
    const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };

    if (pw1 !== pw2) { showErr('Mật khẩu mới nhập lại không khớp.'); return; }

    const ok = await S.verifyOwnPassword(pwOld);
    if (!ok) { showErr('Mật khẩu hiện tại không đúng.'); return; }

    try {
      await S.setOwnPassword(pw1, { mustChangePassword: false });
      toast('Đã đổi mật khẩu thành công', 'success');
      e.target.reset();
    } catch (err) { showErr(err.message || 'Có lỗi xảy ra, thử lại sau.'); }
  });
}
