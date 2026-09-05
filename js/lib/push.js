// Đăng ký/hủy nhận Thông báo đẩy (Web Push) trên THIẾT BỊ đang dùng — mỗi
// thiết bị/trình duyệt là 1 thuê bao (endpoint) riêng, lưu vào bảng
// push_subscriptions qua state.js (xem docs/expense-app-setup.md mục 10).
//
// Giá trị này AN TOÀN để công khai (giống anon key) — bảo mật thật nằm ở
// VAPID_PRIVATE_KEY, chỉ đặt làm Secret trên Edge Function, xem mục 10.3.
export const VAPID_PUBLIC_KEY = 'BP-OmC6JRrfRGTdfn8-FcajBm8ct0Kbho-0I-1hE2wYwWWvsk63pNXyo5ajYstroCzbsS_jJx7HyTZFnb42-fDM';

function urlBase64ToUint8Array(base64url) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function isPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined' && !!VAPID_PUBLIC_KEY;
}

/** Xin quyền + đăng ký nhận push trên thiết bị này. Trả về {endpoint, p256dh, auth} để lưu vào Supabase. */
export async function subscribeThisDevice() {
  if (!isPushSupported()) throw new Error('Thiết bị/trình duyệt này chưa hỗ trợ (hoặc app chưa cấu hình xong) thông báo đẩy.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Bạn chưa cho phép trình duyệt gửi thông báo.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  return { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth };
}

/** Hủy nhận push trên thiết bị này — trả về endpoint vừa hủy (để xóa dòng tương ứng trong Supabase), null nếu chưa từng đăng ký. */
export async function unsubscribeThisDevice() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}

/** Thiết bị này ĐANG có đăng ký push hay không (để hiện đúng trạng thái nút bật/tắt). */
export async function getCurrentEndpoint() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? sub.endpoint : null;
}
