// Service worker — 2 nhiệm vụ:
// 1) Để Chrome/Android coi trang này là "có thể cài đặt" (điều kiện bắt buộc để
//    "Thêm vào màn hình chính" mở ra KHÔNG có thanh địa chỉ, chạy như 1 app
//    riêng, thay vì chỉ tạo 1 shortcut mở trong Chrome bình thường).
// 2) Lưu sẵn "vỏ" app (HTML/CSS/JS cùng gốc) vào Cache Storage để mở được app
//    ngay cả khi KHÔNG có mạng (mở app lần đầu lúc mất mạng, hoặc offline hẳn
//    giữa chừng) — xem yêu cầu "vào app và ghi dữ liệu khi không có mạng" ở
//    docs/expense-app-setup.md. Chiến lược: "network-first" — có mạng thì LUÔN
//    lấy bản mới nhất từ server (và cập nhật lại cache), mất mạng mới dùng bản
//    đã lưu — vẫn giữ đúng nguyên tắc cũ "có mạng thì không bao giờ bị kẹt xem
//    bản cũ", chỉ thêm phương án dự phòng khi KHÔNG có mạng.
//
// CHỈ áp dụng cho request cùng gốc (same-origin) và phương thức GET — request
// tới Supabase (khác gốc) hay các phương thức khác (POST/PATCH/DELETE...) đều
// KHÔNG bị chặn ở đây (không gọi event.respondWith), để state.js tự xử lý mất
// mạng bằng cơ chế outbox/đồng bộ riêng của nó.
const CACHE_NAME = 'chitieu-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Dọn cache cũ (đổi CACHE_NAME khi cần buộc làm mới toàn bộ vỏ app).
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  event.respondWith((async () => {
    try {
      // cache: 'no-store' ép trình duyệt LUÔN xin bản mới nhất từ server khi
      // đang CÓ mạng, không tự ý dùng file đã lưu trước đó — tránh tình trạng
      // "đã đẩy code mới nhưng mở app vẫn thấy bản cũ".
      const fresh = await fetch(req, { cache: 'no-store' });
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (e) {
      // Mất mạng (hoặc server không trả lời) -> dùng bản đã lưu lần gần nhất,
      // nếu chưa từng lưu (VD lần đầu mở app mà đã offline) thì đành báo lỗi.
      const cached = await caches.match(req);
      if (cached) return cached;
      throw e;
    }
  })());
});

// Thông báo đẩy (Web Push) — Edge Function (được pg_cron gọi mỗi phút, xem
// docs/expense-app-setup.md mục 10) gửi 1 payload JSON {title, body, url} tới
// đây, kể cả khi app đang ĐÓNG (service worker vẫn được đánh thức dậy để xử lý).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Sổ chi tiêu', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Sổ chi tiêu';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: 'icons/app-icon-192.png',
    badge: 'icons/app-icon-192.png',
    data: { url: data.url || '#/thong-bao' },
  }));
});

// Bấm vào thông báo -> mở app (hoặc focus tab đang mở sẵn) đúng vào trang Thông báo.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL((event.notification.data && event.notification.data.url) || '#/thong-bao', self.registration.scope).href;
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) { try { await client.navigate(targetUrl); } catch (e) { /* bỏ qua, focus là đủ */ } }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
