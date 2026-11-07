-- Messenger support tickets (M-A). Additive only: one new table, service role only. File only, not applied here.
create table if not exists public.messenger_support_tickets (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  psid text not null check (psid ~ '^[0-9]{5,32}$'),
  reason text not null check (reason in ('human','unclear','self_help','admin_reply')),
  summary text not null default '' check (char_length(summary) <= 200),
  status text not null default 'open' check (status in ('open','in_progress','done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  taken_at timestamptz,
  done_at timestamptz
);

-- One open ticket per sender: concurrent "gặp admin" messages collapse into one row (23505 -> touch).
create unique index if not exists messenger_support_tickets_one_open_per_psid
  on public.messenger_support_tickets (page_id, psid)
  where status in ('open','in_progress');

create index if not exists messenger_support_tickets_status_created_idx
  on public.messenger_support_tickets (status, created_at);

alter table public.messenger_support_tickets enable row level security;
revoke all on table public.messenger_support_tickets from anon, authenticated;
-- New Supabase projects (staging) no longer auto-grant table privileges; the Worker uses the service role key.
grant select, insert, update on table public.messenger_support_tickets to service_role;
