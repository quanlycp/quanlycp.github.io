// Thông báo — 3 việc trong 1 màn hình:
//  1) Bật/tắt Thông báo đẩy (Web Push) trên THIẾT BỊ đang dùng.
//  2) Soạn & gửi ngay 1 thông báo cho 1 người khác / tất cả mọi người / chính mình.
//  3) Đặt LỊCH NHẮC tới đúng ngày giờ mới tự động gửi (không cần mở app lúc đó).
// Cả 2 việc (2) và (3) đều tạo 1 dòng trong bảng notifications, xem state.js
// và docs/expense-app-setup.md mục 10 để biết ai/khi nào thực sự gửi push.
import * as S from '../state.js';
import { icon } from '../icons.js';
import { pageHeader } from '../components/shell.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { emptyState } from '../components/ui.js';
import { toast } from '../components/toast.js';
import { formatDateTime } from '../utils.js';
import { isPushSupported } from '../lib/push.js';

let tab = 'inbox';

export function renderHeader(headerEl) {
  headerEl.innerHTML = pageHeader({ title: 'Thông báo' });
}

export function render(contentEl) {
  const unread = S.unreadInboxCount();
  const scheduled = S.listScheduledNotifications();

  contentEl.innerHTML = `
    <div class="card card-pad mb-16" id="push-card">
      <div class="flex items-center gap-8 mb-4"><b class="text-sm">Thông báo đẩy trên thiết bị này</b></div>
      <p class="text-sm text-muted mb-8" id="push-desc">Đang kiểm tra...</p>
      <button class="btn btn-outline btn-block" id="btn-push-toggle" disabled>Đang kiểm tra...</button>
    </div>

    <div class="mb-16"><button class="btn btn-primary btn-block" id="btn-compose">${icon('message', 'icon-sm')} Soạn thông báo</button></div>

    <div class="tabs mb-16">
      <button data-tab="inbox" class="${tab === 'inbox' ? 'active' : ''}">Hộp thư${unread ? ` (${unread})` : ''}</button>
      <button data-tab="scheduled" class="${tab === 'scheduled' ? 'active' : ''}">Đã lên lịch${scheduled.length ? ` (${scheduled.length})` : ''}</button>
      <button data-tab="sent" class="${tab === 'sent' ? 'active' : ''}">Đã gửi</button>
    </div>
    <div id="noti-list"></div>
  `;

  contentEl.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => { tab = btn.dataset.tab; render(contentEl); });
  });
  contentEl.querySelector('#btn-compose').addEventListener('click', () => openComposeModal());
  renderList(contentEl.querySelector('#noti-list'));
  refreshPushCard(contentEl);
}

async function refreshPushCard(contentEl) {
  const descEl = contentEl.querySelector('#push-desc');
  const btn = contentEl.querySelector('#btn-push-toggle');
  if (!descEl || !btn) return; // đã chuyển màn hình khác trước khi promise xong

  if (!isPushSupported()) {
    descEl.textContent = 'Trình duyệt này chưa hỗ trợ (hoặc app chưa cấu hình xong VAPID_PUBLIC_KEY) thông báo đẩy — xem docs/expense-app-setup.md mục 10.';
    btn.textContent = 'Không khả dụng';
    return;
  }
  const enabled = await S.isThisDevicePushEnabled();
  descEl.textContent = enabled
    ? 'Đã bật — thiết bị này sẽ nhận thông báo dù không mở app.'
    : 'Chưa bật — bật lên để nhận thông báo/lịch nhắc ngay cả khi không mở app.';
  btn.disabled = false;
  btn.textContent = enabled ? 'Tắt thông báo trên thiết bị này' : 'Bật thông báo trên thiết bị này';
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (enabled) { await S.disablePushOnThisDevice(); toast('Đã tắt thông báo trên thiết bị này', 'success'); }
      else { await S.enablePushOnThisDevice(); toast('Đã bật thông báo trên thiết bị này', 'success'); }
    } catch (err) {
      toast(err.message || 'Có lỗi xảy ra', 'error');
    } finally {
      refreshPushCard(contentEl);
    }
  };
}

function recipientLabel(n) {
  const session = S.getSession();
  if (n.toUserId == null) return 'Tất cả mọi người';
  if (n.toUserId === session.id) return 'Chính mình';
  return S.getUser(n.toUserId)?.name || 'Không rõ';
}
function senderLabel(n) {
  const session = S.getSession();
  if (n.fromUserId === session.id) return 'Bạn';
  return S.getUser(n.fromUserId)?.name || 'Không rõ';
}

function renderList(listEl) {
  if (tab === 'inbox') {
    const list = S.listInboxNotifications();
    listEl.innerHTML = list.length ? list.map((n) => `
      <div class="list-row" data-open="${n.id}" style="cursor:pointer">
        <div class="row-thumb" style="background:${n.read ? 'var(--surface-alt)' : 'var(--color-primary)'};color:${n.read ? 'var(--text-muted)' : '#fff'}">${icon('bell', 'icon-sm')}</div>
        <div class="row-main">
          <div class="row-title" style="font-weight:${n.read ? 500 : 700}">${escapeTitle(n.title)}</div>
          <div class="row-sub">${senderLabel(n)} · ${formatDateTime(n.sentAt || n.createdAt)}</div>
        </div>
        ${!n.read ? '<div class="row-end"><span class="nav-badge">Mới</span></div>' : ''}
      </div>`).join('') : `<div class="card card-pad">${emptyState({ iconName: 'bell', title: 'Hộp thư trống', message: 'Thông báo người khác gửi cho bạn (hoặc gửi cho tất cả mọi người) sẽ hiện ở đây.' })}</div>`;
    listEl.querySelectorAll('[data-open]').forEach((row) => {
      row.addEventListener('click', () => openDetail(row.dataset.open));
    });
  } else if (tab === 'scheduled') {
    const list = S.listScheduledNotifications();
    listEl.innerHTML = list.length ? list.map((n) => `
      <div class="list-row">
        <div class="row-thumb" style="background:var(--warning-bg);color:var(--warning)">${icon('clock', 'icon-sm')}</div>
        <div class="row-main">
          <div class="row-title">${escapeTitle(n.title)}</div>
          <div class="row-sub">Gửi cho ${recipientLabel(n)} · lúc ${formatDateTime(n.sendAt)}</div>
        </div>
        <div class="row-end"><button class="btn btn-sm btn-outline" data-cancel="${n.id}">Hủy</button></div>
      </div>`).join('') : `<div class="card card-pad">${emptyState({ iconName: 'clock', title: 'Chưa có lịch nhắc nào', message: 'Đặt lịch để app tự nhắc đúng ngày giờ, kể cả khi bạn không mở app lúc đó.' })}</div>`;
    listEl.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.cancel;
        confirmDialog({
          title: 'Hủy lịch nhắc?', message: 'Thông báo này sẽ không được gửi nữa.', confirmLabel: 'Hủy lịch', danger: true,
          onConfirm: async () => {
            try { await S.cancelScheduledNotification(id); toast('Đã hủy lịch nhắc', 'success'); }
            catch (err) { toast(err.message || 'Có lỗi xảy ra', 'error'); }
          },
        });
      });
    });
  } else {
    const list = S.listSentNotifications();
    listEl.innerHTML = list.length ? list.map((n) => `
      <div class="list-row">
        <div class="row-thumb" style="background:var(--surface-alt)">${icon('message', 'icon-sm')}</div>
        <div class="row-main">
          <div class="row-title">${escapeTitle(n.title)}</div>
          <div class="row-sub">Gửi cho ${recipientLabel(n)} · lúc ${formatDateTime(n.sentAt)}</div>
        </div>
      </div>`).join('') : `<div class="card card-pad">${emptyState({ iconName: 'message', title: 'Chưa gửi thông báo nào', message: 'Bấm "Soạn thông báo" để gửi cho người khác hoặc đặt lịch nhắc.' })}</div>`;
  }
}

function escapeTitle(s) {
  return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function openDetail(id) {
  const n = S.listInboxNotifications().find((x) => x.id === id);
  if (!n) return;
  S.markNotificationRead(id);
  openModal({
    title: n.title,
    bodyHtml: `
      <p class="text-sm text-muted mb-8">${senderLabel(n)} · ${formatDateTime(n.sentAt || n.createdAt)}</p>
      <p style="font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeTitle(n.body) || '<i>(Không có nội dung)</i>'}</p>
    `,
  });
}

function openComposeModal() {
  const session = S.getSession();
  let mode = 'now'; // 'now' | 'schedule'
  const recipients = [
    { value: 'SELF', label: 'Chỉ mình tôi (tự nhắc bản thân)' },
    ...S.listMembers().filter((u) => u.id !== session.id).map((u) => ({ value: u.id, label: u.name })),
    { value: 'ALL', label: 'Tất cả mọi người' },
  ];

  const close = openModal({
    title: 'Soạn thông báo',
    bodyHtml: `
      <form id="noti-form">
        <div class="field">
          <label>Gửi cho</label>
          <select name="to" required>${recipients.map((r) => `<option value="${r.value}">${r.label}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Tiêu đề</label><input name="title" required placeholder="VD: Nhớ đóng tiền điện" maxlength="100"/></div>
        <div class="field"><label>Nội dung</label><textarea name="body" rows="3" placeholder="Không bắt buộc"></textarea></div>
        <div class="tabs mb-16">
          <button type="button" data-mode="now" class="active">Gửi ngay</button>
          <button type="button" data-mode="schedule">Đặt lịch nhắc</button>
        </div>
        <div id="schedule-fields" class="field-row" style="display:none">
          <div class="field"><label>Ngày</label><input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"/></div>
          <div class="field"><label>Giờ</label><input name="time" type="time"/></div>
        </div>
        <div class="field-error" id="noti-error" style="display:none;margin-bottom:10px"></div>
        <button class="btn btn-primary btn-block" type="submit">${icon('check', 'icon-sm')} Gửi</button>
      </form>
    `,
    onMount(sheet) {
      const form = sheet.querySelector('#noti-form');
      const scheduleFields = sheet.querySelector('#schedule-fields');
      const submitBtn = form.querySelector('button[type="submit"]');
      sheet.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          mode = btn.dataset.mode;
          sheet.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
          scheduleFields.style.display = mode === 'schedule' ? 'grid' : 'none';
          submitBtn.innerHTML = mode === 'schedule' ? `${icon('clock', 'icon-sm')} Đặt lịch nhắc` : `${icon('check', 'icon-sm')} Gửi ngay`;
        });
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const rawTo = fd.get('to');
        const toUserId = rawTo === 'ALL' ? null : rawTo === 'SELF' ? session.id : rawTo;
        const title = fd.get('title');
        const body = fd.get('body');
        const errEl = sheet.querySelector('#noti-error');
        errEl.style.display = 'none';
        submitBtn.disabled = true;
        try {
          if (mode === 'now') {
            await S.sendNotificationNow({ toUserId, title, body });
            toast('Đã gửi thông báo (có thể mất tới ~1 phút để tới thiết bị người nhận)', 'success');
          } else {
            const date = fd.get('date');
            const time = fd.get('time');
            if (!date || !time) throw new Error('Cần chọn đủ ngày và giờ nhắc.');
            const sendAt = new Date(`${date}T${time}:00`);
            if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now()) throw new Error('Giờ nhắc phải ở trong tương lai.');
            await S.scheduleReminder({ toUserId, title, body, sendAt });
            toast('Đã đặt lịch nhắc', 'success');
          }
          close();
        } catch (err) {
          errEl.textContent = err.message || 'Có lỗi xảy ra, thử lại sau.';
          errEl.style.display = 'block';
        } finally {
          submitBtn.disabled = false;
        }
      });
    },
  });
}
