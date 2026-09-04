// Tạo 1 cặp khóa VAPID (dùng cho thông báo đẩy/Web Push) — chạy 1 LẦN trên máy bạn:
//
//   node scripts/generate-vapid-keys.js
//
// In ra 2 giá trị:
//   - VAPID_PUBLIC_KEY  : dán vào js/lib/push.js (AN TOÀN để công khai/commit,
//     giống anon key) VÀ vào Supabase Edge Functions → Secrets.
//   - VAPID_PRIVATE_KEY : CHỈ dán vào Supabase Edge Functions → Secrets.
//     TUYỆT ĐỐI không commit/dán vào bất cứ file nào chạy trong trình duyệt.
//
// Xem đầy đủ các bước còn lại ở docs/expense-app-setup.md mục 10.
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function main() {
  const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicRaw = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey)); // 65 byte: 0x04 || x || y
  const privateJwk = await subtle.exportKey('jwk', keyPair.privateKey); // lấy "d" (khóa riêng dạng scalar 32 byte)

  console.log('\nĐã tạo cặp khóa VAPID mới — KHÔNG chia sẻ VAPID_PRIVATE_KEY cho ai:\n');
  console.log('VAPID_PUBLIC_KEY  =', b64url(publicRaw));
  console.log('VAPID_PRIVATE_KEY =', privateJwk.d);
  console.log('\nXem docs/expense-app-setup.md mục 10 để biết dán 2 giá trị này vào đâu.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
