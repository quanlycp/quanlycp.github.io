// Edge Function GỘP CHUNG (1 function duy nhất, đỡ phải deploy nhiều chỗ) —
// app "Sổ Chi Tiêu": đăng nhập, tự đổi mật khẩu, và owner tạo/sửa/xóa tài
// khoản member (Use phụ). Toàn bộ logic nhạy cảm (băm/so mật khẩu, cấp JWT,
// ghi bảng users) chạy Ở ĐÂY (server), KHÔNG chạy trong trình duyệt — dùng
// service_role key không lộ ra ngoài. Xem docs/expense-app-setup.md.
//
// Mọi thao tác KHÔNG nhạy cảm (categories/transactions/budgets/recurring/
// savings_goals/app_settings) KHÔNG đi qua function này — trình duyệt gọi
// thẳng Supabase bằng JWT do function này cấp, để Row Level Security tự lọc.
//
// Cách gọi: POST body luôn có field "type":
//   { type: 'login', identifier, password }
//     -> PHẢI gọi trước để lấy JWT — không cần JWT sẵn có.
//   { type: 'verify-own-password', password } / { type: 'set-own-password',
//     newPassword, mustChangePassword? } -> tự đổi mật khẩu CHÍNH MÌNH, cần
//     JWT hợp lệ (owner hoặc member đều được).
//   { type: 'send-due' } -> hệ thống (pg_cron gọi mỗi phút), cần header
//     "x-cron-secret" đúng CRON_SECRET_KEY, KHÔNG dùng JWT — gửi push cho các
//     thông báo/lịch nhắc trong bảng notifications đã tới giờ (xem
//     docs/expense-app-setup.md mục 10).
//   Tất cả các "type" còn lại BẮT BUỘC header Authorization: Bearer <JWT>
//   của 1 user role='owner' (xác minh lại tại server, không tin JWT mù):
//     { type: 'member', username, name?, password? } — tạo tài khoản member mới
//     { type: 'reset-member-password', userId, password? }
//     { type: 'delete-member', userId }
// password bỏ trống thì tự sinh mật khẩu tạm ngẫu nhiên (trả về trong response).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET = Deno.env.get('CUSTOM_JWT_SECRET')!;
// Thông báo đẩy (Web Push) — xem docs/expense-app-setup.md mục 10. 3 biến VAPID_* dùng để
// "tự giới thiệu" với dịch vụ push của trình duyệt + mã hóa nội dung; CRON_SECRET_KEY là mật
// khẩu riêng để pg_cron (chạy mỗi phút trong Supabase) được phép gọi type 'send-due' bên dưới
// — KHÔNG dùng JWT người dùng vì đây là tác vụ hệ thống, không ai đang đăng nhập lúc đó cả.
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com';
const CRON_SECRET_KEY = Deno.env.get('CRON_SECRET_KEY') || '';

const LOCK_AFTER_FAILS = 5;
const LOCK_MINUTES = 15;
// App gia đình/cá nhân, không cần bắt đăng nhập lại thường xuyên như app ngân hàng -> để phiên
// sống rất lâu (10 năm, coi như không hết hạn trong thực tế) thay vì 12 tiếng như trước.
const SESSION_HOURS = 24 * 365 * 10;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// ---------- Mật khẩu — GIỐNG HỆT thuật toán trong js/state.js ----------
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes: number): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function genTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const arr = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(arr).map((b) => chars[b % chars.length]).join('');
}
async function makeCredential(plainPassword: string): Promise<{ salt: string; hash: string }> {
  const salt = randomHex(8);
  const hash = await sha256Hex(salt + ':' + plainPassword);
  return { salt, hash };
}
async function verifyCredential(password: string, salt: string, hash: string): Promise<boolean> {
  return (await sha256Hex(salt + ':' + password)) === hash;
}
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- JWT tự ký/tự xác minh (không dùng Supabase Auth/auth.users thật) ----------
function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const toSign = `${encHeader}.${encPayload}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign));
  return `${toSign}.${base64url(new Uint8Array(sigBuf))}`;
}
async function verifyJwt(token: string): Promise<Record<string, any> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSig] = parts;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, base64urlDecode(encSig), new TextEncoder().encode(`${encHeader}.${encPayload}`));
  if (!ok) return null;
  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(encPayload)));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ---------- Web Push (thông báo đẩy) — gộp thẳng vào đây (thay vì file riêng webpush.ts) để cả
// function chỉ có ĐÚNG 1 FILE, dán 1 lần là xong (đỡ phải tạo thêm file phụ trên Supabase Dashboard,
// nhất là khi thao tác trên điện thoại). Viết tay bằng Web Crypto API có sẵn trong Deno, KHÔNG cần
// thư viện ngoài (thư viện "web-push" của Node dùng nhiều API không có trên Deno Edge Runtime).
//
// Gồm 2 phần theo đúng chuẩn:
//  - RFC 8292 (VAPID): ký 1 JWT ES256 bằng khóa riêng của app để "tự giới thiệu" với dịch vụ push
//    (Chrome/Firefox/Safari...), kèm khóa công khai.
//  - RFC 8291 ("aes128gcm"): mã hóa nội dung thông báo bằng khóa suy ra từ ECDH (giữa 1 cặp khóa
//    tạm sinh mới mỗi lần gửi + khóa public của trình duyệt lưu lúc đăng ký) + khóa "auth" bí mật
//    của thuê bao. Xem docs/expense-app-setup.md mục 10 để biết cách tạo cặp khóa VAPID.
function wpB64urlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function wpB64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function wpConcatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/** Dựng lại CryptoKey (để ký ES256) từ 2 chuỗi base64url lưu ở Edge Function Secrets. */
async function importVapidPrivateKey(publicKeyB64url: string, privateKeyB64url: string): Promise<CryptoKey> {
  const pub = wpB64urlDecode(publicKeyB64url); // 65 byte: 0x04 || x(32) || y(32), dạng "uncompressed point"
  const jwk: JsonWebKey = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: wpB64urlEncode(pub.slice(1, 33)), y: wpB64urlEncode(pub.slice(33, 65)), d: privateKeyB64url,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function buildVapidHeader(endpoint: string, publicKey: string, privateKey: string, subject: string): Promise<string> {
  const origin = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: origin, exp: now + 12 * 3600, sub: subject };
  const encHeader = wpB64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = wpB64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;
  const key = await importVapidPrivateKey(publicKey, privateKey);
  // ECDSA + Web Crypto ký ra thẳng dạng "raw" (r||s, 64 byte) — đúng format JWS ES256 cần, không phải DER.
  const sigBuf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return `vapid t=${signingInput}.${wpB64urlEncode(new Uint8Array(sigBuf))}, k=${publicKey}`;
}

type WebPushSubscription = { endpoint: string; p256dh: string; auth: string };

/** Mã hóa `payload` (1 object sẽ được JSON.stringify) theo RFC 8291 rồi POST tới đúng thuê bao. */
async function sendWebPush(
  sub: WebPushSubscription,
  payload: Record<string, unknown>,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string,
): Promise<{ ok: boolean; status: number; expired: boolean }> {
  const uaPublic = wpB64urlDecode(sub.p256dh); // khóa public của trình duyệt (65 byte), lưu lúc đăng ký
  const authSecret = wpB64urlDecode(sub.auth); // "auth secret" bí mật của thuê bao (16 byte)

  // 1) Cặp khóa ECDH TẠM, sinh mới cho MỖI lần gửi (không tái sử dụng).
  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));
  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, asKeyPair.privateKey, 256));

  // 2) ikm = HKDF(salt=authSecret, ikm=sharedSecret, info="WebPush: info"||0x00||uaPublic||asPublic, 32 byte) — RFC 8291 §3.3.
  const ecdhKey = await crypto.subtle.importKey('raw', sharedSecret, { name: 'HKDF' }, false, ['deriveBits']);
  const ikmInfo = wpConcatBytes(new TextEncoder().encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: ikmInfo }, ecdhKey, 256);

  // 3) cek/nonce = HKDF(salt=recordSalt(16 byte ngẫu nhiên), ikm, info=...) — RFC 8188 (đóng gói "aes128gcm").
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const cekBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: wpConcatBytes(new TextEncoder().encode('Content-Encoding: aes128gcm'), new Uint8Array([0])) }, ikmKey, 128);
  const nonceBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: wpConcatBytes(new TextEncoder().encode('Content-Encoding: nonce'), new Uint8Array([0])) }, ikmKey, 96);

  // 4) Mã hóa nội dung — thêm 1 byte 0x02 ở cuối làm "delimiter" cuối record (RFC 8188), rồi AES-128-GCM.
  const aesKey = await crypto.subtle.importKey('raw', cekBits, { name: 'AES-GCM' }, false, ['encrypt']);
  const plaintext = wpConcatBytes(new TextEncoder().encode(JSON.stringify(payload)), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(nonceBits) }, aesKey, plaintext));

  // 5) Ghép phần "header" (salt + kích thước record + khóa public tạm) + phần đã mã hóa, theo đúng layout RFC 8188.
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096); // đủ lớn cho 1 thông báo (không cần chia nhiều record)
  const body = wpConcatBytes(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);

  const vapidHeader = await buildVapidHeader(sub.endpoint, vapidPublicKey, vapidPrivateKey, vapidSubject);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: '86400', Authorization: vapidHeader },
    body,
  });
  // Dịch vụ push trả 404/410 khi thuê bao đã hết hạn/bị hủy phía trình duyệt -> nên xóa khỏi push_subscriptions.
  return { ok: res.ok, status: res.status, expired: res.status === 404 || res.status === 410 };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, reason: 'Method not allowed' }, 405);

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, reason: 'Yêu cầu không hợp lệ.' }, 400);
  }

  // ===== type: 'login' — KHÔNG cần JWT sẵn có, đây là chỗ tạo ra JWT =====
  if (body.type === 'login') {
    const identifier = String(body.identifier || '').trim();
    const password = String(body.password || '');
    if (!identifier || !password) return json({ ok: false, reason: 'Thiếu thông tin đăng nhập.' }, 400);

    const { data: row, error } = await admin.from('users').select('*').eq('username', identifier).maybeSingle();
    if (error) { console.error('query users error:', error); return json({ ok: false, reason: 'Lỗi hệ thống, thử lại sau.' }, 500); }
    if (!row) return json({ ok: false, reason: 'Sai tên đăng nhập hoặc mật khẩu.' });
    if (!row.salt || !row.hash) return json({ ok: false, reason: 'Tài khoản này chưa được cấp mật khẩu — liên hệ chủ sổ.' });
    if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 60000);
      return json({ ok: false, reason: `Tài khoản tạm khóa do nhập sai nhiều lần. Thử lại sau ${mins} phút.` });
    }

    const okPw = await verifyCredential(password, row.salt, row.hash);
    if (!okPw) {
      const failedAttempts = (row.failed_attempts || 0) + 1;
      const patch: Record<string, unknown> = { failed_attempts: failedAttempts };
      if (failedAttempts >= LOCK_AFTER_FAILS) { patch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString(); patch.failed_attempts = 0; }
      await admin.from('users').update(patch).eq('id', row.id);
      return json({ ok: false, reason: 'Sai tên đăng nhập hoặc mật khẩu.' });
    }

    await admin.from('users').update({ failed_attempts: 0, locked_until: null }).eq('id', row.id);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      sub: row.auth_user_id, role: 'authenticated', app_role: row.role, row_id: row.id,
      iat: now, exp: now + SESSION_HOURS * 3600,
    });
    return json({ ok: true, token, id: row.id, role: row.role, name: row.name, mustChangePassword: !!row.must_change_password });
  }

  // ===== type: 'verify-own-password' / 'set-own-password' — tự đổi mật khẩu
  // CHÍNH MÌNH, cần JWT hợp lệ (owner hoặc member đều được) =====
  if (body.type === 'verify-own-password' || body.type === 'set-own-password') {
    const authHeader = req.headers.get('Authorization') || '';
    const selfToken = authHeader.replace(/^Bearer\s+/i, '');
    const selfClaims = selfToken ? await verifyJwt(selfToken) : null;
    if (!selfClaims || !selfClaims.app_role) {
      return json({ ok: false, reason: 'Chưa đăng nhập hoặc phiên đã hết hạn.' }, 401);
    }

    if (body.type === 'verify-own-password') {
      const { data: row } = await admin.from('users').select('salt, hash').eq('id', selfClaims.row_id).maybeSingle();
      if (!row || !row.salt || !row.hash) return json({ ok: true, valid: false });
      const valid = await verifyCredential(body.password || '', row.salt, row.hash);
      return json({ ok: true, valid });
    }

    const newPw = String(body.newPassword || '').trim();
    if (newPw.length < 6) return json({ ok: false, reason: 'Mật khẩu mới phải từ 6 ký tự.' }, 400);
    const cred = await makeCredential(newPw);
    const patch: Record<string, unknown> = { ...cred, must_change_password: !!body.mustChangePassword };
    const { error } = await admin.from('users').update(patch).eq('id', selfClaims.row_id);
    if (error) return json({ ok: false, reason: 'Lỗi hệ thống, thử lại sau.' }, 500);
    return json({ ok: true });
  }

  // ===== type: 'send-due' — pg_cron gọi mỗi phút (KHÔNG có JWT người dùng nào cả, đây là
  // tác vụ hệ thống) để gửi push cho các thông báo/lịch nhắc đã tới giờ. Xác thực bằng 1 mật
  // khẩu riêng (CRON_SECRET_KEY) qua header, không dùng verifyJwt() ở trên. =====
  if (body.type === 'send-due') {
    const cronSecret = req.headers.get('x-cron-secret') || '';
    if (!CRON_SECRET_KEY || cronSecret !== CRON_SECRET_KEY) return json({ ok: false, reason: 'Unauthorized' }, 401);
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return json({ ok: false, reason: 'Chưa cấu hình VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY.' }, 500);

    const { data: pending, error } = await admin.from('notifications').select('*').eq('status', 'pending').limit(500);
    if (error) { console.error('query notifications error:', error); return json({ ok: false, reason: 'Lỗi hệ thống, thử lại sau.' }, 500); }

    const now = Date.now();
    // Lọc "đã tới giờ" ở đây (thay vì trong query) để khỏi phải lo cú pháp lọc timestamp của
    // PostgREST với chuỗi ISO chứa dấu ":"/".": dễ viết sai, còn số lượng "đang chờ" của app
    // gia đình/cá nhân này chắc chắn nhỏ nên lọc ở code không tốn kém gì.
    const due = (pending || []).filter((n) => !n.send_at || new Date(n.send_at).getTime() <= now);

    let sent = 0;
    for (const n of due) {
      let q = admin.from('push_subscriptions').select('*');
      if (n.to_user_id) q = q.eq('user_id', n.to_user_id); // không có to_user_id = gửi cho TẤT CẢ thiết bị đã đăng ký
      const { data: subs } = await q;
      for (const s of subs || []) {
        try {
          const result = await sendWebPush(
            { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth_key },
            { title: n.title, body: n.body || '', url: '#/thong-bao' },
            VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
          );
          if (result.expired) await admin.from('push_subscriptions').delete().eq('id', s.id);
        } catch (e) {
          console.error('sendWebPush error:', e);
        }
      }
      await admin.from('notifications').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', n.id);
      sent++;
    }
    return json({ ok: true, sent });
  }

  // ===== Mọi type khác: bắt buộc JWT của user role='owner' =====
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const claims = token ? await verifyJwt(token) : null;
  if (!claims || !claims.app_role) {
    return json({ ok: false, reason: 'Chưa đăng nhập hoặc phiên đã hết hạn.' }, 401);
  }
  if (claims.app_role !== 'owner') {
    return json({ ok: false, reason: 'Chỉ chủ sổ (owner) mới được thực hiện thao tác này.' }, 403);
  }

  if (body.type === 'member') {
    const username = String(body.username || '').trim();
    if (!username) return json({ ok: false, reason: 'Cần nhập tên đăng nhập.' }, 400);
    const { data: existing } = await admin.from('users').select('id').eq('username', username).maybeSingle();
    if (existing) return json({ ok: false, reason: 'Tên đăng nhập đã tồn tại.' }, 409);

    const finalPassword = body.password && String(body.password).trim() ? String(body.password).trim() : genTempPassword();
    const cred = await makeCredential(finalPassword);
    const userId = genId('user');

    const { error } = await admin.from('users').insert({
      id: userId, username, name: body.name || username, role: 'member',
      salt: cred.salt, hash: cred.hash, must_change_password: true,
      failed_attempts: 0, locked_until: null,
    });
    if (error) return json({ ok: false, reason: 'Lỗi hệ thống, thử lại sau.' }, 500);
    return json({ ok: true, id: userId, tempPassword: finalPassword });
  }

  if (body.type === 'reset-member-password') {
    const userId = String(body.userId || '').trim();
    if (!userId) return json({ ok: false, reason: 'Thiếu mã tài khoản.' }, 400);
    const finalPassword = body.password && String(body.password).trim() ? String(body.password).trim() : genTempPassword();
    const cred = await makeCredential(finalPassword);
    const { error } = await admin.from('users').update({ ...cred, must_change_password: true, failed_attempts: 0, locked_until: null }).eq('id', userId).eq('role', 'member');
    if (error) return json({ ok: false, reason: 'Lỗi hệ thống, thử lại sau.' }, 500);
    return json({ ok: true, tempPassword: finalPassword });
  }

  if (body.type === 'delete-member') {
    const userId = String(body.userId || '').trim();
    if (!userId) return json({ ok: false, reason: 'Thiếu mã tài khoản.' }, 400);
    // .eq('role','member') chặn cứng việc xóa nhầm/xóa owner qua đường này — owner không tự xóa được chính mình.
    const { error, count } = await admin.from('users').delete({ count: 'exact' }).eq('id', userId).eq('role', 'member');
    if (error) return json({ ok: false, reason: 'Lỗi hệ thống, thử lại sau.' }, 500);
    if (!count) return json({ ok: false, reason: 'Không tìm thấy tài khoản member này.' }, 404);
    return json({ ok: true });
  }

  return json({ ok: false, reason: 'Thiếu hoặc sai "type".' }, 400);
});
