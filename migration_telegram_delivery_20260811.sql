-- Telegram delivery mode for Commerce Clone.
-- Existing rows remain LMS by default. Telegram order fields are snapshots so
-- changing a course later does not mutate the delivery path of older orders.

alter table public.courses
  add column if not exists delivery_mode text not null default 'lms',
  add column if not exists telegram_chat_id text,
  add column if not exists telegram_chat_title text,
  add column if not exists telegram_invite_ttl_hours integer not null default 72,
  add column if not exists telegram_connect_request_id bigint,
  add column if not exists telegram_connect_user_id bigint,
  add column if not exists telegram_connect_expires_at timestamptz;

alter table public.orders
  add column if not exists delivery_mode text not null default 'lms',
  add column if not exists telegram_chat_id text,
  add column if not exists telegram_invite_link text,
  add column if not exists telegram_invite_name text,
  add column if not exists telegram_invite_expires_at timestamptz,
  add column if not exists telegram_user_id bigint,
  add column if not exists telegram_username text,
  add column if not exists telegram_first_name text,
  add column if not exists telegram_join_status text,
  add column if not exists telegram_join_requested_at timestamptz,
  add column if not exists telegram_join_decided_at timestamptz,
  add column if not exists telegram_join_update_id bigint;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'courses_delivery_mode_check') then
    alter table public.courses
      add constraint courses_delivery_mode_check
      check (delivery_mode in ('lms', 'telegram'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'courses_telegram_invite_ttl_check') then
    alter table public.courses
      add constraint courses_telegram_invite_ttl_check
      check (telegram_invite_ttl_hours between 1 and 720);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_delivery_mode_check') then
    alter table public.orders
      add constraint orders_delivery_mode_check
      check (delivery_mode in ('lms', 'telegram'));
  end if;
end $$;

create index if not exists idx_courses_telegram_connect_request
  on public.courses (telegram_connect_request_id)
  where telegram_connect_request_id is not null;

create index if not exists idx_orders_telegram_invite_link
  on public.orders (telegram_invite_link)
  where telegram_invite_link is not null;

create index if not exists idx_orders_telegram_user_id
  on public.orders (telegram_user_id)
  where telegram_user_id is not null;
