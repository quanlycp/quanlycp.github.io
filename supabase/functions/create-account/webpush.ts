// Gửi Web Push (thông báo đẩy) THẲNG tới trình duyệt của người dùng — viết
// tay bằng Web Crypto API có sẵn trong Deno, KHÔNG cần thư viện ngoài (thư
// viện "web-push" của Node dùng nhiều API không có trên Deno Edge Runtime).
//
// Gồm 2 phần theo đúng chuẩn:
//  - RFC 8292 (VAPID): ký 1 JWT ES256 bằng khóa riêng của app để "tự giới
//    thiệu" với dịch vụ push (Chrome/Firefox/Safari...), kèm khóa công khai.
//  - RFC 8291 ("aes128gcm"): mã hóa nội dung thông báo bằng khóa suy ra từ
//    ECDH (giữa 1 cặp khóa tạm sinh mới mỗi lần gửi + khóa public của trình
//    duyệt lưu lúc đăng ký) + khóa "auth" bí mật của thuê bao.
//
// Xem docs/expense-app-setup.md mục 10 để biết cách tạo cặp khóa VAPID.

function b64urlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/** Dựng lại CryptoKey (để ký ES256) từ 2 chuỗi base64url lưu ở Edge Function Secrets. */
async function importVapidPrivateKey(publicKeyB64url: string, privateKeyB64url: string): Promise<CryptoKey> {
  const pub = b64urlDecode(publicKeyB64url); // 65 byte: 0x04 || x(32) || y(32), dạng "uncompressed point"
  const jwk: JsonWebKey = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), d: privateKeyB64url,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function buildVapidHeader(endpoint: string, publicKey: string, privateKey: string, subject: string): Promise<string> {
  const origin = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: origin, exp: now + 12 * 3600, sub: subject };
  const encHeader = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;
  const key = await importVapidPrivateKey(publicKey, privateKey);
  // ECDSA + Web Crypto ký ra thẳng dạng "raw" (r||s, 64 byte) — đúng format JWS ES256 cần, không phải DER.
  const sigBuf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return `vapid t=${signingInput}.${b64urlEncode(new Uint8Array(sigBuf))}, k=${publicKey}`;
}

export type WebPushSubscription = { endpoint: string; p256dh: string; auth: string };

/** Mã hóa `payload` (1 object sẽ được JSON.stringify) theo RFC 8291 rồi POST tới đúng thuê bao. */
export async function sendWebPush(
  sub: WebPushSubscription,
  payload: Record<string, unknown>,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string,
): Promise<{ ok: boolean; status: number; expired: boolean }> {
  const uaPublic = b64urlDecode(sub.p256dh); // khóa public của trình duyệt (65 byte), lưu lúc đăng ký
  const authSecret = b64urlDecode(sub.auth); // "auth secret" bí mật của thuê bao (16 byte)

  // 1) Cặp khóa ECDH TẠM, sinh mới cho MỖI lần gửi (không tái sử dụng).
  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));
  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, asKeyPair.privateKey, 256));

  // 2) ikm = HKDF(salt=authSecret, ikm=sharedSecret, info="WebPush: info"||0x00||uaPublic||asPublic, 32 byte) — RFC 8291 §3.3.
  const ecdhKey = await crypto.subtle.importKey('raw', sharedSecret, { name: 'HKDF' }, false, ['deriveBits']);
  const ikmInfo = concatBytes(new TextEncoder().encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: ikmInfo }, ecdhKey, 256);

  // 3) cek/nonce = HKDF(salt=recordSalt(16 byte ngẫu nhiên), ikm, info=...) — RFC 8188 (đóng gói "aes128gcm").
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const cekBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: concatBytes(new TextEncoder().encode('Content-Encoding: aes128gcm'), new Uint8Array([0])) }, ikmKey, 128);
  const nonceBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: concatBytes(new TextEncoder().encode('Content-Encoding: nonce'), new Uint8Array([0])) }, ikmKey, 96);

  // 4) Mã hóa nội dung — thêm 1 byte 0x02 ở cuối làm "delimiter" cuối record (RFC 8188), rồi AES-128-GCM.
  const aesKey = await crypto.subtle.importKey('raw', cekBits, { name: 'AES-GCM' }, false, ['encrypt']);
  const plaintext = concatBytes(new TextEncoder().encode(JSON.stringify(payload)), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(nonceBits) }, aesKey, plaintext));

  // 5) Ghép phần "header" (salt + kích thước record + khóa public tạm) + phần đã mã hóa, theo đúng layout RFC 8188.
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096); // đủ lớn cho 1 thông báo (không cần chia nhiều record)
  const body = concatBytes(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);

  const vapidHeader = await buildVapidHeader(sub.endpoint, vapidPublicKey, vapidPrivateKey, vapidSubject);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: '86400', Authorization: vapidHeader },
    body,
  });
  // Dịch vụ push trả 404/410 khi thuê bao đã hết hạn/bị hủy phía trình duyệt -> nên xóa khỏi push_subscriptions.
  return { ok: res.ok, status: res.status, expired: res.status === 404 || res.status === 410 };
}
