-- Add V4 Web as a third Commerce delivery mode.
-- Existing LMS and Telegram rows are unchanged.

alter table public.courses drop constraint if exists courses_delivery_mode_check;
alter table public.courses
  add constraint courses_delivery_mode_check
  check (delivery_mode in ('lms', 'v4', 'telegram'));

alter table public.orders drop constraint if exists orders_delivery_mode_check;
alter table public.orders
  add constraint orders_delivery_mode_check
  check (delivery_mode in ('lms', 'v4', 'telegram'));
