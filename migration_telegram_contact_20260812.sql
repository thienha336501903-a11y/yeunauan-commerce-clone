alter table public.orders add column if not exists telegram_claimed_username text;
alter table public.orders alter column customer_email drop not null;
comment on column public.orders.telegram_claimed_username is 'Telegram nickname/username entered by customer at checkout for Telegram delivery orders';
