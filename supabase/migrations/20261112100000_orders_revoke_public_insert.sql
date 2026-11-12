-- C2-2: orders are written by the server only (service role, utils/bill-order.js). The old policy let anyone
-- holding the public anon key insert a row straight into public.orders. File only, not applied here.
-- RLS stays enabled and is not forced: service_role bypasses RLS, and no policy means no access for other roles.
--
-- Rollback (restores the public insert path; the original WITH CHECK text is reconstructed, not copied):
--   grant insert on table public.orders to anon, authenticated;
--   create policy orders_anon_insert_only on public.orders for insert to anon, authenticated
--     with check (customer_email is not null and btrim(customer_email) <> '');
drop policy if exists orders_anon_insert_only on public.orders;
revoke all on table public.orders from public, anon, authenticated;

-- Stop (and roll the transaction back) unless the result is exactly: no public write path, server access intact.
do $$
begin
  if has_table_privilege('anon', 'public.orders', 'INSERT') or has_table_privilege('authenticated', 'public.orders', 'INSERT')
     or has_any_column_privilege('anon', 'public.orders', 'INSERT') or has_any_column_privilege('authenticated', 'public.orders', 'INSERT') then
    raise exception 'C2-2: anon or authenticated can still insert into public.orders';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'orders'
             and roles && array['public', 'anon', 'authenticated']::name[]) then
    raise exception 'C2-2: a policy on public.orders still names public, anon or authenticated';
  end if;
  if not (has_table_privilege('service_role', 'public.orders', 'SELECT') and has_table_privilege('service_role', 'public.orders', 'INSERT')
          and has_table_privilege('service_role', 'public.orders', 'UPDATE') and has_table_privilege('service_role', 'public.orders', 'DELETE')) then
    raise exception 'C2-2: service_role lost access to public.orders';
  end if;
end $$;
