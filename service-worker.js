// Service worker TỐI GIẢN — mục đích DUY NHẤT là để Chrome/Android coi trang này
// là "có thể cài đặt" (điều kiện bắt buộc để "Thêm vào màn hình chính" mở ra
// KHÔNG có thanh địa chỉ, chạy như 1 app riêng, thay vì chỉ tạo 1 shortcut mở
// trong Chrome bình thường). KHÔNG cache gì cả — app đang phát triển liên tục,
// cache ở đây dễ làm người dùng bị kẹt xem code cũ sau khi có bản cập nhật.
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  // cache: 'no-store' ép trình duyệt LUÔN xin bản mới nhất từ server, không tự
  // ý dùng file đã lưu trước đó — tránh tình trạng "đã đẩy code mới nhưng mở
  // app vẫn thấy bản cũ" ở tab thường (trong khi ẩn danh thì luôn đúng vì
  // ẩn danh không có cache).
  event.respondWith(fetch(event.request, { cache: 'no-store' }));
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
