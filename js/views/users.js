import * as S from '../state.js';
import { icon } from '../icons.js';
import { pageHeader } from '../components/shell.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openResetPasswordModal } from '../components/ui.js';
import { toast } from '../components/toast.js';
import { initials, colorFor } from '../utils.js';

export function renderHeader(headerEl) {
  headerEl.innerHTML = pageHeader({ title: 'Quản lý User' });
}

export function render(contentEl) {
  const members = S.listMembers();
  contentEl.innerHTML = `
    <div class="mb-16"><button class="btn btn-primary btn-block" id="btn-add">${icon('plus', 'icon-sm')} Thêm thành viên (Use)</button></div>
    <p class="text-sm text-muted mb-16">Mọi thành viên dùng CHUNG 1 sổ chi tiêu — tạo thêm để người khác (vợ/chồng, con...) cùng ghi sổ. Chỉ bạn (chủ sổ) mới thêm/xóa/cấp lại mật khẩu được.</p>
    <div class="card">${members.map((u) => memberRowHtml(u)).join('')}</div>
  `;
  contentEl.querySelector('#btn-add').addEventListener('click', () => openAddMemberModal());
  contentEl.querySelectorAll('[data-member]').forEach((row) => {
    row.addEventListener('click', () => openMemberActions(members.find((u) => u.id === row.dataset.member)));
  });
}

function memberRowHtml(u) {
  return `
    <div class="list-row" data-member="${u.id}" style="cursor:pointer">
      <div class="row-thumb" style="background:${colorFor(u.id)}">${initials(u.name)}</div>
      <div class="row-main">
        <div class="row-title">${u.name}</div>
        <div class="row-sub">${u.role === 'owner' ? 'Chủ sổ (toàn quyền)' : 'Thành viên'}</div>
      </div>
      ${icon('chevronRight', 'icon-sm')}
    </div>`;
}

function openAddMemberModal() {
  openModal({
    title: 'Thêm thành viên',
    bodyHtml: `
      <div class="field"><label>Tên hiển thị</label><input id="mem-name" required/></div>
      <div class="field"><label>Tên đăng nhập</label><input id="mem-username" required autocomplete="off"/></div>
      <div class="field"><label>Mật khẩu</label><input id="mem-pw" placeholder="Để trống sẽ tự sinh mật khẩu tạm"/></div>
      <div class="field-error" id="mem-error" style="display:none;margin-bottom:10px"></div>
    `,
    footHtml: `<button class="btn btn-primary btn-block" data-save>Tạo tài khoản</button>`,
    onMount(sheet, closeFn) {
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        const name = sheet.querySelector('#mem-name').value.trim();
        const username = sheet.querySelector('#mem-username').value.trim();
        const password = sheet.querySelector('#mem-pw').value;
        const errEl = sheet.querySelector('#mem-error');
        if (!name || !username) { errEl.textContent = 'Cần nhập đủ tên và tên đăng nhập.'; errEl.style.display = 'block'; return; }
        try {
          const res = await S.addMember({ name, username, password });
          closeFn();
          showCredentialModal(name, username, res.tempPassword);
        } catch (err) { errEl.textContent = err.message || 'Có lỗi xảy ra'; errEl.style.display = 'block'; }
      });
    },
  });
}

function showCredentialModal(name, username, tempPassword) {
  openModal({
    title: 'Đã tạo tài khoản',
    bodyHtml: `
      <p class="text-sm text-muted mb-16">Gửi thông tin này cho <b>${name}</b> — mật khẩu chỉ hiện ra 1 LẦN DUY NHẤT ở đây, hãy chụp/lưu lại ngay.</p>
      <div class="oc-line"><span>Tên đăng nhập</span><b>${username}</b></div>
      <div class="oc-line"><span>Mật khẩu tạm</span><b>${tempPassword}</b></div>
    `,
    footHtml: `<button class="btn btn-primary btn-block" data-close>Đã lưu, đóng lại</button>`,
    onMount(sheet, closeFn) { sheet.querySelector('[data-close]').addEventListener('click', closeFn); },
  });
}

function openMemberActions(u) {
  if (!u) return;
  openModal({
    title: u.name,
    bodyHtml: `<p class="text-sm text-muted">${u.role === 'owner' ? 'Chủ sổ (toàn quyền).' : 'Thành viên.'}</p>`,
    footHtml: `
      <button class="btn btn-outline btn-block" data-rename>${icon('edit', 'icon-sm')} Đổi tên hiển thị</button>
      ${u.role !== 'owner' ? `
      <button class="btn btn-outline btn-block" data-reset style="margin-top:8px">${icon('key', 'icon-sm')} Cấp lại mật khẩu</button>
      <button class="btn btn-danger-outline btn-block" data-del style="margin-top:8px">${icon('trash', 'icon-sm')} Xóa tài khoản</button>` : ''}
    `,
    onMount(sheet, closeFn) {
      sheet.querySelector('[data-rename]').addEventListener('click', () => {
        closeFn();
        openRenameModal(u);
      });
      const resetBtn = sheet.querySelector('[data-reset]');
      if (resetBtn) resetBtn.addEventListener('click', () => {
        closeFn();
        openResetPasswordModal({
          title: `Cấp lại mật khẩu — ${u.name}`,
          onConfirm: async (pw) => {
            try {
              const tempPassword = await S.resetMemberPassword(u.id, pw);
              showCredentialModal(u.name, '(giữ nguyên tên đăng nhập cũ)', tempPassword);
            } catch (err) { toast(err.message || 'Có lỗi xảy ra', 'error'); }
          },
        });
      });
      const delBtn = sheet.querySelector('[data-del]');
      if (delBtn) delBtn.addEventListener('click', () => {
        closeFn();
        confirmDialog({
          title: 'Xóa tài khoản?', message: `Xóa hẳn tài khoản của ${u.name} — không thể hoàn tác. Giao dịch cũ họ đã ghi vẫn được giữ nguyên trong sổ chung.`, confirmLabel: 'Xóa', danger: true,
          onConfirm: async () => {
            try { await S.deleteMember(u.id); toast('Đã xóa tài khoản', 'success'); }
            catch (err) { toast(err.message || 'Có lỗi xảy ra', 'error'); }
          },
        });
      });
    },
  });
}

/** Đổi tên hiển thị 1 tài khoản — dùng chung renameMember() (owner đổi tên bất kỳ ai, kể cả chính
 * mình) vì màn này chỉ owner mới vào được (xem NAV_OWNER_ONLY ở components/shell.js). */
function openRenameModal(u) {
  openModal({
    title: 'Đổi tên hiển thị',
    bodyHtml: `
      <div class="field"><label>Tên hiển thị</label><input id="rename-name" value="${u.name.replace(/"/g, '&quot;')}" required/></div>
      <div class="field-error" id="rename-error" style="display:none;margin-bottom:10px"></div>
    `,
    footHtml: `<button class="btn btn-primary btn-block" data-save>Lưu thay đổi</button>`,
    onMount(sheet, closeFn) {
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        const name = sheet.querySelector('#rename-name').value.trim();
        const errEl = sheet.querySelector('#rename-error');
        if (!name) { errEl.textContent = 'Cần nhập tên.'; errEl.style.display = 'block'; return; }
        try {
          await S.renameMember(u.id, name);
          toast('Đã đổi tên', 'success');
          closeFn();
        } catch (err) { errEl.textContent = err.message || 'Có lỗi xảy ra'; errEl.style.display = 'block'; }
      });
    },
  });
}
