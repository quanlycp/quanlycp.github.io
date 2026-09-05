import * as S from '../state.js';
import { icon } from '../icons.js';
import { toast } from '../components/toast.js';

export function renderLogin(root, onLoggedIn) {
  const settings = S.getSettings();
  root.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="logo-mark">${icon('wallet', 'icon-lg')}</div>
        <h1 style="text-align:center;font-size:18px;margin-bottom:4px">${settings.householdName}</h1>
        <p style="text-align:center;font-size:12.5px;color:var(--text-muted);margin-bottom:20px">Đăng nhập để quản lý chi tiêu</p>

        <form id="login-form">
          <div class="field">
            <label>Tên đăng nhập</label>
            <input name="username" required autocomplete="username" placeholder="Nhập tên đăng nhập"/>
          </div>
          <div class="field">
            <label>Mật khẩu</label>
            <input name="password" type="password" required autocomplete="current-password" placeholder="Nhập mật khẩu"/>
          </div>
          <div class="field-error" id="login-error" style="display:none;margin-bottom:10px"></div>
          <button class="btn btn-primary btn-block" type="submit">${icon('lock', 'icon-sm')} Đăng nhập</button>
        </form>
      </div>
    </div>
  `;

  // Bị chủ động đăng xuất do phiên cũ hết hạn (xem state.js refresh()) -> báo rõ lý do, kẻo người
  // dùng tưởng nhầm là mất dữ liệu khi thấy màn đăng nhập hiện ra bất ngờ.
  if (S.consumeSessionExpiredNotice()) {
    toast('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.', 'error');
  }

  root.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const username = fd.get('username').trim();
    const password = fd.get('password');
    root.querySelector('#login-error').style.display = 'none';

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    // Đăng nhập sai mật khẩu kích hoạt notify() (lưu số lần nhập sai) ->
    // render lại toàn bộ màn hình đăng nhập, xóa mất các phần tử DOM đã lấy
    // ở trên. Vì vậy sau khi await xong phải lấy lại #login-error/nút bấm
    // MỚI từ `root` (chỉ `root` là còn nguyên) thay vì dùng lại tham chiếu cũ.
    try {
      const res = await S.login(username, password);
      if (!res.ok) {
        const err = root.querySelector('#login-error');
        if (err) { err.textContent = res.reason; err.style.display = 'block'; }
        return;
      }
      S.setSession({ id: res.userId, role: res.role, mustChangePassword: res.mustChangePassword, sbToken: res.sbToken });
      toast('Đăng nhập thành công', 'success');
      onLoggedIn();
    } finally {
      const btn = root.querySelector('#login-form button[type="submit"]');
      if (btn) btn.disabled = false;
    }
  });
}
