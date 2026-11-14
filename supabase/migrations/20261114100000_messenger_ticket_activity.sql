-- Messenger tickets: "Có tin mới" for the Admin (Owner 14/11). Additive only: two nullable timestamps, no data copied.
-- customer_msg_at: last customer message while the ticket is open (written by touchTicket, customer events only).
-- seen_at: last time the Admin marked it seen ("Đã xem") or answered from the Page inbox.
-- "New" = customer_msg_at > coalesce(seen_at, '-infinity'). No message text, image or name is stored.
-- Rollback (drops only these two columns):
--   alter table public.messenger_support_tickets drop column if exists customer_msg_at, drop column if exists seen_at;
alter table public.messenger_support_tickets
  add column if not exists customer_msg_at timestamptz,
  add column if not exists seen_at timestamptz;
