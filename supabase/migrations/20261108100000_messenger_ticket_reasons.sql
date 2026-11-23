-- Messenger V2: two new ticket reasons (other_course, support). File only, not applied here.
-- The default Postgres name of the inline check on messenger_support_tickets.reason is messenger_support_tickets_reason_check.
-- Rollback (only while no row uses a new reason):
--   alter table public.messenger_support_tickets drop constraint if exists messenger_support_tickets_reason_check;
--   alter table public.messenger_support_tickets add constraint messenger_support_tickets_reason_check
--     check (reason in ('human','unclear','self_help','admin_reply'));
alter table public.messenger_support_tickets drop constraint if exists messenger_support_tickets_reason_check;
alter table public.messenger_support_tickets add constraint messenger_support_tickets_reason_check
  check (reason in ('human','unclear','self_help','admin_reply','other_course','support'));
