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

const LOCK_AFTER_FAILS = 5;
const LOCK_MINUTES = 15;
const SESSION_HOURS = 12;

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
