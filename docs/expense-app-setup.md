# Sổ Chi Tiêu — hướng dẫn tạo Supabase project mới

> App đã được viết lại toàn bộ từ "Quỹ tín dụng" sang **quản lý chi tiêu cá nhân/gia đình**. Vì
> bạn muốn tách hẳn khỏi dữ liệu quỹ tín dụng cũ, app này cần **1 project Supabase MỚI, riêng biệt**
> (không dùng chung với project cũ). Làm đúng theo thứ tự dưới đây — y hệt lần trước, chỉ đổi schema.

## 1. Tạo project mới

1. Vào [supabase.com](https://supabase.com) → **New project** → đặt tên (VD: `so-chi-tieu`) → đặt
   **Database Password** (lưu lại chỗ an toàn) → chọn Region **Singapore** → **Create new project**.
2. Vào **Project Settings → API**, lấy 2 giá trị: **Project URL** và **anon public key** — 2 giá trị
   này được phép công khai/commit (bảo mật thật nằm ở RLS + Edge Function, không phải giấu key).
3. Vào **Project Settings → API → JWT Keys**, tìm **"Legacy JWT secret"** (hoặc "JWT Secret") — copy
   giá trị này lại, **không dán vào chat**, sẽ dùng ở bước 4.

## 2. Tạo bảng (schema)

Mở **SQL Editor** → chạy nguyên đoạn dưới:

```sql
create extension if not exists pgcrypto;

-- Người dùng: 1 "owner" (bạn, toàn quyền) + nhiều "member" (Use phụ owner tạo
-- thêm) — TẤT CẢ dùng CHUNG 1 sổ chi tiêu (giao dịch/danh mục/ngân sách...
-- không tách riêng theo người), chỉ khác nhau ở quyền quản lý thành viên.
create table users (
  id text primary key,
  username text unique not null,
  name text not null,
  role text not null check (role in ('owner','member')),
  salt text,
  hash text,
  must_change_password boolean default true,
  failed_attempts int default 0,
  locked_until timestamptz,
  auth_user_id uuid unique default gen_random_uuid(), -- KHÔNG phải auth.users thật, xem mục 4
  created_at timestamptz default now()
);
-- View an toàn: chỉ lộ tên/vai trò, KHÔNG lộ salt/hash — dùng để hiện "người
-- ghi giao dịch" / danh sách thành viên trên giao diện mà không cần đi qua
-- Edge Function. Bảng users thật thì KHÔNG cấp quyền đọc trực tiếp cho client
-- (xem GRANT ở mục 3) — chỉ Edge Function (service_role) mới đọc được salt/hash.
create view user_profiles as select id, name, role, created_at from users;

create table categories (
  id text primary key,
  name text not null,
  type text not null check (type in ('expense','income')),
  icon text not null default 'tag',
  color text not null default '#0f6f61',
  monthly_budget numeric, -- hạn mức ngân sách MẶC ĐỊNH hàng tháng (có thể ghi đè riêng theo tháng ở bảng budgets)
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz default now()
);

create table recurring_transactions (
  id text primary key,
  type text not null check (type in ('expense','income')),
  amount numeric not null,
  category_id text references categories(id) on delete set null,
  note text,
  day_of_month int not null check (day_of_month between 1 and 28),
  active boolean not null default true,
  user_id text references users(id) on delete set null,
  created_at timestamptz default now()
);

create table transactions (
  id text primary key,
  type text not null check (type in ('expense','income')),
  amount numeric not null check (amount > 0),
  category_id text references categories(id) on delete set null,
  note text,
  txn_date date not null,
  user_id text references users(id) on delete set null, -- ai ghi giao dịch này
  recurring_id text references recurring_transactions(id) on delete set null, -- có nếu ghi từ nhắc định kỳ, để không nhắc lại trong tháng
  created_at timestamptz default now()
);

create table budgets (
  id text primary key,
  year int not null,
  month int not null check (month between 1 and 12),
  category_id text not null references categories(id) on delete cascade,
  amount numeric not null,
  created_at timestamptz default now(),
  unique (year, month, category_id)
);

create table savings_goals (
  id text primary key,
  name text not null,
  target_amount numeric not null,
  current_amount numeric not null default 0,
  deadline date,
  note text,
  user_id text references users(id) on delete set null,
  created_at timestamptz default now()
);

-- Kế hoạch chi tiêu: khoản thu/chi DỰ ĐỊNH (vd "cuối tháng mua sắm 2 triệu")
-- — chỉ để nhắc/theo dõi, CHƯA tính vào thu/chi thật cho tới khi tick "Hoàn
-- thành" (lúc đó mới tự tạo 1 dòng trong transactions, xem transaction_id).
create table plans (
  id text primary key,
  type text not null check (type in ('expense','income')),
  amount numeric not null,
  category_id text references categories(id) on delete set null,
  title text not null,
  due_date date,
  status text not null default 'pending' check (status in ('pending','done')),
  transaction_id text references transactions(id) on delete set null,
  user_id text references users(id) on delete set null,
  created_at timestamptz default now()
);

-- Quản lý nợ theo TỪNG CHỦ NỢ (vd "Tạp hóa A", "Anh Ba") — mỗi chủ nợ có 1
-- sổ riêng gồm nhiều dòng: "ghi nợ" (mua gì, ngày nào, nợ bao nhiêu) và "trả
-- nợ" (ngày nào, trả bao nhiêu). Còn nợ = tổng ghi nợ - tổng trả nợ, tính
-- ngay khi đọc dữ liệu (không lưu cột riêng để khỏi lệch). Ghi nợ KHÔNG tạo
-- giao dịch (chưa mất tiền thật) — chỉ "trả nợ" mới tự tạo 1 giao dịch chi
-- tiêu thật (xem debt_entries.transaction_id) để không lệch tổng chi tháng.
create table creditors (
  id text primary key,
  name text not null, -- tên chủ nợ/khách hàng, VD "Tạp hóa A"
  note text,
  user_id text references users(id) on delete set null,
  created_at timestamptz default now()
);
create table debt_entries (
  id text primary key,
  creditor_id text not null references creditors(id) on delete cascade,
  kind text not null check (kind in ('charge','payment')), -- charge = ghi nợ thêm, payment = trả nợ
  amount numeric not null,
  entry_date date not null default current_date,
  description text, -- charge: mua gì; payment: ghi chú (không bắt buộc)
  transaction_id text references transactions(id) on delete set null,
  user_id text references users(id) on delete set null,
  created_at timestamptz default now()
);

create table app_settings (
  id text primary key default 'main',
  household_name text not null default 'Sổ chi tiêu của tôi',
  currency text not null default 'đ'
);
insert into app_settings (id) values ('main');

create index on transactions (txn_date);
create index on transactions (category_id);
create index on transactions (user_id);
create index on budgets (year, month);
create index on plans (status);
create index on plans (due_date);
create index on creditors (user_id);
create index on debt_entries (creditor_id);
create index on debt_entries (entry_date);
```

## 3. Row Level Security + quyền bảng

```sql
alter table users enable row level security;
alter table categories enable row level security;
alter table recurring_transactions enable row level security;
alter table transactions enable row level security;
alter table budgets enable row level security;
alter table savings_goals enable row level security;
alter table plans enable row level security;
alter table creditors enable row level security;
alter table debt_entries enable row level security;
alter table app_settings enable row level security;

grant usage on schema public to anon, authenticated, service_role;

-- users: KHÔNG cấp gì cho anon/authenticated — chỉ service_role (Edge
-- Function) được đọc/ghi trực tiếp, vì bảng này có salt/hash mật khẩu.
grant select, insert, update, delete on users to service_role;
grant select on user_profiles to anon, authenticated;

grant select, insert, update, delete on categories, recurring_transactions, transactions, budgets, savings_goals, plans, creditors, debt_entries
  to authenticated, service_role;
grant select on app_settings to anon, authenticated;
grant update on app_settings to authenticated, service_role;

-- Mọi người dùng đã đăng nhập (owner hoặc member) đều đọc/ghi CHUNG 1 sổ —
-- không tách riêng theo người, chỉ cần đúng JWT hợp lệ do Edge Function cấp.
create policy "authenticated full access categories" on categories
  for all using ((auth.jwt() ->> 'app_role') in ('owner','member'))
  with check ((auth.jwt() ->> 'app_role') in ('owner','member'));
create policy "authenticated full access recurring" on recurring_transactions
  for all using ((auth.jwt() ->> 'app_role') in ('owner','member'))
  with check ((auth.jwt() ->> 'app_role') in ('owner','member'));
create policy "authenticated full access transactions" on transactions
  for all using ((auth.jwt() ->> 'app_role') in ('owner','member'))
  with check ((auth.jwt() ->> 'app_role') in ('owner','member'));
create policy "authenticated full access budgets" on budgets
  for all using ((auth.jwt() ->> 'app_role') in ('owner','member'))
  with check ((auth.jwt() ->> 'app_role') in ('owner','member'));
create policy "authenticated full access savings" on savings_goals
  for all using ((auth.jwt() ->> 'app_role') in ('owner','member'))
  with check ((auth.jwt() ->> 'app_role') in ('owner','member'));
create policy "authenticated full access plans" on plans
  for all using ((auth.jwt() ->> 'app_role') in ('owner','member'))
  with check ((auth.jwt() ->> 'app_role') in ('owner','member'));
-- Quản lý nợ RIÊNG của từng người dùng (không chia sẻ như các bảng trên) —
-- mỗi người chỉ xem/sửa được đúng chủ nợ/sổ nợ do mình tạo (kể cả owner).
create policy "own creditors only" on creditors
  for all using ((auth.jwt() ->> 'row_id') = user_id)
  with check ((auth.jwt() ->> 'row_id') = user_id);
create policy "own debt_entries only" on debt_entries
  for all using ((auth.jwt() ->> 'row_id') = user_id)
  with check ((auth.jwt() ->> 'row_id') = user_id);

-- app_settings: ai cũng xem được (tên sổ hiện ở màn đăng nhập, chưa cần đăng
-- nhập cũng phải thấy), chỉ owner sửa được.
create policy "anyone sees settings" on app_settings for select using (true);
create policy "owner updates settings" on app_settings
  for update using ((auth.jwt() ->> 'app_role') = 'owner');
```

## 4. Xác thực — giữ nguyên kiến trúc JWT tự ký đã dùng ở app cũ

Không dùng Supabase Auth/GoTrue — Edge Function tự băm/so mật khẩu (SHA-256 salted, giống hệt code cũ)
rồi **tự ký 1 JWT** bằng "Legacy JWT secret" của project này, chứa `app_role` ('owner'/'member') và
`row_id` (id của dòng trong bảng `users`) để RLS ở trên dùng. Không có OTP (giữ đúng quyết định đã
chốt trước đây: bảo mật cơ bản — mật khẩu băm + JWT ký server — là đủ cho quy mô gia đình/cá nhân).

### Deploy Edge Function
1. Vào Supabase Dashboard → menu ☰ → **Edge Functions** → tạo function mới (tên gì cũng được).
2. Copy toàn bộ nội dung `supabase/functions/create-account/index.ts` trong repo này → dán → **Deploy**.
3. Vào **Edge Functions → Secrets** → thêm secret **`CUSTOM_JWT_SECRET`**, dán giá trị "Legacy JWT
   secret" đã lấy ở bước 1.3 → Save.
4. Copy đúng **URL thật** của function vừa deploy (không phải tên hiển thị) → báo lại để cập nhật
   `js/lib/supabaseClient.js` (3 giá trị cần cập nhật: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `API_FN_URL`).

## 5. Tài khoản owner đầu tiên

Vì chưa có tài khoản nào để tự tạo tài khoản đầu tiên (owner), chạy tay 1 lần trong SQL Editor —
thay `TEN_DANG_NHAP`/`MAT_KHAU` trước khi chạy (mật khẩu này chỉ dùng để đăng nhập lần đầu, app sẽ
bắt đổi ngay sau đó vì `must_change_password` mặc định `true`):

```sql
-- Chạy trong SQL Editor — Postgres có sẵn hàm băm digest() từ extension pgcrypto đã bật ở mục 2.
insert into users (id, username, name, role, salt, hash, must_change_password)
select
  'owner_1', 'TEN_DANG_NHAP', 'Chủ sổ', 'owner',
  salt, encode(digest(salt || ':' || 'MAT_KHAU', 'sha256'), 'hex'), true
from (select encode(gen_random_bytes(8), 'hex') as salt) s;
```

## 7. Bổ sung sau: bảng "Kế hoạch chi tiêu" (nếu project đã tạo trước khi có mục này)

Nếu bạn đã chạy schema ở mục 2 TRƯỚC KHI bảng `plans` được thêm vào tài liệu này, chạy bổ sung
đúng đoạn SQL sau trong **SQL Editor** (không ảnh hưởng gì tới dữ liệu đã có):

```sql
create table plans (
  id text primary key,
  type text not null check (type in ('expense','income')),
  amount numeric not null,
  category_id text references categories(id) on delete set null,
  title text not null,
  due_date date,
  status text not null default 'pending' check (status in ('pending','done')),
  transaction_id text references transactions(id) on delete set null,
  user_id text references users(id) on delete set null,
  created_at timestamptz default now()
);
create index on plans (status);
create index on plans (due_date);

alter table plans enable row level security;
grant select, insert, update, delete on plans to authenticated, service_role;
create policy "authenticated full access plans" on plans
  for all using ((auth.jwt() ->> 'app_role') in ('owner','member'))
  with check ((auth.jwt() ->> 'app_role') in ('owner','member'));
```

Sau đó cần **deploy lại Edge Function** với code mới nhất (không đổi gì về SQL/JWT, chỉ để chắc
chắn code khớp bản mới nhất — xem lại mục 4).

## 8. Bổ sung sau: bảng "Quản lý nợ" theo chủ nợ (nếu project đã tạo trước khi có mục này)

Đoạn dưới **tự xóa bảng `debts`/`debt_payments` bản cũ nếu có** (bản cũ dùng thử trước đó,
kiểu 1-khoản-nợ-tổng, chưa theo chủ nợ) rồi tạo lại đúng theo mô hình sổ nợ theo từng chủ nợ.
Nếu bạn CHƯA từng chạy SQL nợ nào thì lệnh `drop` chỉ đơn giản không làm gì, an toàn để chạy:

```sql
drop table if exists debt_payments;
drop table if exists debts;

create table creditors (
  id text primary key,
  name text not null,
  note text,
  user_id text references users(id) on delete set null,
  created_at timestamptz default now()
);
create table debt_entries (
  id text primary key,
  creditor_id text not null references creditors(id) on delete cascade,
  kind text not null check (kind in ('charge','payment')),
  amount numeric not null,
  entry_date date not null default current_date,
  description text,
  transaction_id text references transactions(id) on delete set null,
  user_id text references users(id) on delete set null,
  created_at timestamptz default now()
);
create index on creditors (user_id);
create index on debt_entries (creditor_id);
create index on debt_entries (entry_date);

alter table creditors enable row level security;
alter table debt_entries enable row level security;
grant select, insert, update, delete on creditors, debt_entries to authenticated, service_role;
-- Riêng của từng người dùng — mỗi người chỉ xem/sửa được đúng chủ nợ/sổ nợ do mình tạo (kể cả owner).
create policy "own creditors only" on creditors
  for all using ((auth.jwt() ->> 'row_id') = user_id)
  with check ((auth.jwt() ->> 'row_id') = user_id);
create policy "own debt_entries only" on debt_entries
  for all using ((auth.jwt() ->> 'row_id') = user_id)
  with check ((auth.jwt() ->> 'row_id') = user_id);
```

## 10. Bổ sung sau: Thông báo đẩy (Push Notifications) — gửi tin cho người khác + lịch nhắc tự động

Tính năng: 1 người dùng có thể **soạn & gửi ngay 1 thông báo cho 1 người khác (hoặc tất cả mọi
người, hoặc tự nhắc chính mình)**, hoặc **đặt lịch nhắc tới đúng ngày giờ mới tự động gửi** — cả 2
đều gửi được **Thông báo đẩy thật (Web Push)** tới điện thoại/máy tính, kể cả khi KHÔNG mở app lúc
đó (giống tin nhắn thật báo về máy). Vào trang **Thông báo** trong app sau khi làm xong các bước
dưới đây.

Cơ chế: mọi thông báo/lịch nhắc được ghi vào 1 "hàng đợi" (bảng `notifications`) với
`status='pending'`. Mỗi phút, **Supabase tự gọi 1 lần** vào Edge Function (qua `pg_cron` +
`pg_net`, không cần máy chủ riêng nào khác) để quét các dòng đã tới giờ và gửi push thật — vì vậy
"gửi ngay" có thể trễ tối đa khoảng 1 phút, việc bình thường với quy mô gia đình/cá nhân.

### 10.1 Tạo bảng (chạy trong SQL Editor)

```sql
create table push_subscriptions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  endpoint text not null unique, -- 1 thiết bị/trình duyệt = 1 endpoint riêng do trình duyệt cấp
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz default now()
);
create index on push_subscriptions (user_id);

create table notifications (
  id text primary key,
  from_user_id text references users(id) on delete set null,
  to_user_id text references users(id) on delete cascade, -- null = gửi cho TẤT CẢ mọi người
  title text not null,
  body text not null default '',
  status text not null default 'pending' check (status in ('pending','sent','cancelled')),
  send_at timestamptz, -- null = gửi ngay (lượt quét pg_cron kế tiếp); có giá trị = lịch nhắc
  created_at timestamptz default now(),
  sent_at timestamptz
);
create index on notifications (status);
create index on notifications (to_user_id);
create index on notifications (from_user_id);

-- Trạng thái "đã đọc" lưu RIÊNG mỗi người 1 dòng cho mỗi thông báo — vì 1
-- thông báo gửi cho "tất cả" thì mỗi người đọc/chưa đọc độc lập với nhau.
create table notification_reads (
  notification_id text not null references notifications(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);

alter table push_subscriptions enable row level security;
alter table notifications enable row level security;
alter table notification_reads enable row level security;

grant select, insert, update, delete on push_subscriptions, notifications, notification_reads
  to authenticated, service_role;

-- Mỗi người chỉ quản lý được đăng ký push của CHÍNH THIẾT BỊ/TÀI KHOẢN mình.
create policy "own push subscriptions" on push_subscriptions
  for all using ((auth.jwt() ->> 'row_id') = user_id)
  with check ((auth.jwt() ->> 'row_id') = user_id);

-- Xem được: thông báo gửi riêng cho mình, HOẶC gửi cho tất cả, HOẶC do chính mình gửi (để xem lại
-- lịch sử đã gửi/lịch đã đặt). Tạo mới: chỉ tạo được với from_user_id = chính mình. Sửa (đổi
-- status='cancelled' để hủy lịch, hoặc do Edge Function service_role đổi 'sent'): người tạo hoặc
-- người nhận. Xóa: chỉ người tạo.
create policy "see own inbox or sent" on notifications
  for select using (
    (auth.jwt() ->> 'row_id') = to_user_id or to_user_id is null or (auth.jwt() ->> 'row_id') = from_user_id
  );
create policy "create own notifications" on notifications
  for insert with check ((auth.jwt() ->> 'row_id') = from_user_id);
create policy "update own inbox or own pending" on notifications
  for update using (
    (auth.jwt() ->> 'row_id') = to_user_id or (auth.jwt() ->> 'row_id') = from_user_id
  );
create policy "delete own sent" on notifications
  for delete using ((auth.jwt() ->> 'row_id') = from_user_id);

create policy "own reads" on notification_reads
  for all using ((auth.jwt() ->> 'row_id') = user_id)
  with check ((auth.jwt() ->> 'row_id') = user_id);
```

### 10.2 Tạo cặp khóa VAPID (để ký/mã hóa thông báo đẩy)

Chạy trên máy bạn (cần Node.js, máy nào có Node là chạy được, không cần cài gì thêm):

```bash
node scripts/generate-vapid-keys.js
```

In ra 2 giá trị `VAPID_PUBLIC_KEY` và `VAPID_PRIVATE_KEY` — giữ lại cả 2, dùng ở bước 10.3 và 10.4.

### 10.3 Deploy lại Edge Function + thêm Secrets

1. Copy lại toàn bộ nội dung MỚI của `supabase/functions/create-account/index.ts` **VÀ**
   `supabase/functions/create-account/webpush.ts` (function này giờ có 2 file) → dán đè vào Edge
   Function đã tạo ở mục 4 → **Deploy** lại.
2. Vào **Edge Functions → Secrets**, thêm 4 secrets mới:
   - `VAPID_PUBLIC_KEY` — dán giá trị lấy được ở bước 10.2.
   - `VAPID_PRIVATE_KEY` — dán giá trị lấy được ở bước 10.2 (secret, không lộ ra ngoài).
   - `VAPID_SUBJECT` — `mailto:` + email của bạn (bắt buộc phải có, dịch vụ push dùng để liên hệ
     nếu app gửi quá nhiều/spam), VD `mailto:ban@gmail.com`.
   - `CRON_SECRET_KEY` — tự nghĩ 1 chuỗi ký tự ngẫu nhiên dài (VD 32 ký tự bất kỳ) — mật khẩu riêng
     để `pg_cron` được phép gọi vào function, không liên quan tới tài khoản đăng nhập nào.

### 10.4 Cập nhật code phía trình duyệt

Mở `js/lib/push.js`, điền `VAPID_PUBLIC_KEY` (đúng giá trị lấy ở bước 10.2 — public key này AN
TOÀN để commit công khai, giống anon key, khác với `VAPID_PRIVATE_KEY` tuyệt đối không được đặt ở
đây).

### 10.5 Bật lịch tự động gửi (pg_cron, chạy mỗi phút)

Vào **Database → Extensions**, bật (Enable) 2 extension: **pg_cron** và **pg_net**. Sau đó chạy
trong **SQL Editor** (thay `EDGE_FUNCTION_URL` bằng đúng URL thật của function — chính là `API_FN_URL` đã điền ở mục 4,
`ANON_KEY` bằng anon public key của project ở mục 1.2, và `CRON_SECRET_KEY_VALUE` bằng đúng giá
trị đã đặt ở bước 10.3):

```sql
select cron.schedule(
  'send-due-notifications',
  '* * * * *', -- mỗi phút
  $$
  select net.http_post(
    url := 'EDGE_FUNCTION_URL',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ANON_KEY',
      'x-cron-secret', 'CRON_SECRET_KEY_VALUE'
    ),
    body := jsonb_build_object('type', 'send-due')
  );
  $$
);
```

Kiểm tra đã chạy chưa: `select * from cron.job;` (thấy job `send-due-notifications`) và
`select * from cron.job_run_details order by start_time desc limit 5;` (xem lịch sử chạy, cột
`status` phải là `succeeded`).

### 10.6 Thử nghiệm

1. Mở app → **Thông báo** → bấm **"Bật thông báo trên thiết bị này"** → cho phép khi trình duyệt
   hỏi quyền.
2. Bấm **"Soạn thông báo"** → chọn người nhận **"Chỉ mình tôi"** → nhập tiêu đề → **Gửi ngay**.
3. Chờ tối đa ~1 phút, điện thoại/máy tính sẽ hiện thông báo dù đã tắt tab trình duyệt (miễn thiết
   bị còn kết nối mạng và trình duyệt/hệ điều hành đang chạy).

Lưu ý: Safari/iOS chỉ hỗ trợ Web Push từ khi đã **"Thêm vào màn hình chính"** (cài như app riêng),
mở trực tiếp trong Safari thường sẽ không xin được quyền thông báo.

## 11. Bổ sung sau: "Công nợ phải thu" (người khác nợ mình) (nếu project đã tạo trước khi có mục này)

Trang **Công nợ** (trước là "Quản lý nợ") giờ có 2 chiều: **"Tôi nợ"** (đã có từ mục 8 — mình nợ
người khác) và **"Người khác nợ tôi"** (mới) — mô hình y hệt mục 8, chỉ đổi chiều: theo từng
**người nợ** (`debtors`), mỗi người 1 sổ riêng gồm dòng **"cho vay"** (`lend` — tăng số họ nợ mình)
và **"thu tiền"** (`collect` — giảm). Khác 1 điểm so với "Tôi nợ": cho vay = tiền THẬT SỰ rời khỏi
túi mình (nếu tích "đưa vào chi tiêu" → tạo giao dịch **CHI**), thu tiền = tiền THẬT SỰ về túi mình
(nếu tích → tạo giao dịch **THU**) — ngược pha với "Tôi nợ" (ở đó cả ghi nợ lẫn trả nợ đều là chi).

```sql
create table debtors (
  id text primary key,
  name text not null, -- tên người ĐANG NỢ MÌNH, VD "Anh Ba"
  note text,
  user_id text references users(id) on delete set null,
  created_at timestamptz default now()
);
create table receivable_entries (
  id text primary key,
  debtor_id text not null references debtors(id) on delete cascade,
  kind text not null check (kind in ('lend','collect')), -- lend = cho vay/bán chịu thêm, collect = thu hồi
  amount numeric not null,
  entry_date date not null default current_date,
  description text,
  transaction_id text references transactions(id) on delete set null,
  user_id text references users(id) on delete set null,
  created_at timestamptz default now()
);
create index on debtors (user_id);
create index on receivable_entries (debtor_id);
create index on receivable_entries (entry_date);

alter table debtors enable row level security;
alter table receivable_entries enable row level security;
grant select, insert, update, delete on debtors, receivable_entries to authenticated, service_role;
-- Riêng của từng người dùng, giống hệt creditors/debt_entries ở mục 8.
create policy "own debtors only" on debtors
  for all using ((auth.jwt() ->> 'row_id') = user_id)
  with check ((auth.jwt() ->> 'row_id') = user_id);
create policy "own receivable_entries only" on receivable_entries
  for all using ((auth.jwt() ->> 'row_id') = user_id)
  with check ((auth.jwt() ->> 'row_id') = user_id);
```

Không cần deploy lại Edge Function cho mục này (không có thao tác nhạy cảm nào mới) — trình duyệt
đọc/ghi thẳng 2 bảng trên qua Row Level Security, giống `creditors`/`debt_entries`.

## 12. Việc còn lại

- [ ] Đổi mật khẩu owner ngay sau lần đăng nhập đầu tiên (app tự bắt đổi).
- [ ] Rà soát dữ liệu chi tiêu thật trước khi coi là "đang dùng thật".
- [ ] (Tùy chọn) Làm theo mục 10 nếu muốn dùng Thông báo đẩy/lịch nhắc tự động.
- [ ] (Tùy chọn) Làm theo mục 11 nếu muốn dùng "Công nợ phải thu" (người khác nợ mình).
