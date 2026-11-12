// C2-2: nothing but the server writes public.orders, and the server writes it with the service role.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const sql = read("supabase/migrations/20261112100000_orders_revoke_public_insert.sql");
const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

test("RLS-1 the migration drops the public insert policy, revokes the grants and grants nothing back", () => {
  assert.match(statements, /drop policy if exists orders_anon_insert_only on public\.orders;/);
  assert.match(statements, /revoke all on table public\.orders from public, anon, authenticated;/);
  assert.doesNotMatch(statements, /\bgrant\b|create policy|disable row level security|force row level security/i);
});

test("RLS-2 the migration aborts unless anon/authenticated are locked out and service_role keeps full access", () => {
  assert.match(statements, /has_table_privilege\('anon', 'public\.orders', 'INSERT'\) or has_table_privilege\('authenticated', 'public\.orders', 'INSERT'\)[\s\S]*?raise exception/);
  for (const role of ["anon", "authenticated"]) assert.ok(statements.includes(`has_any_column_privilege('${role}', 'public.orders', 'INSERT')`), role);
  assert.match(statements, /roles && array\['public', 'anon', 'authenticated'\]::name\[\][\s\S]*?raise exception/);
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) assert.ok(statements.includes(`has_table_privilege('service_role', 'public.orders', '${privilege}')`), privilege);
});

test("RLS-3 no later migration grants it back, and the app's only order insert goes through the service-role client", () => {
  const later = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.endsWith(".sql") && name > "20261112100000_orders_revoke_public_insert.sql");
  for (const name of later) assert.doesNotMatch(read("supabase/migrations/" + name), /on (table )?public\.orders[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i, name);
  assert.match(read("utils/supabase.js"), /export const supabase = supabaseServiceRole;/);
  const billOrder = read("utils/bill-order.js");
  assert.match(billOrder, /supabase\.from\('orders'\)\.insert\(orderPayload\)/);
  assert.match(billOrder, /from ['"]\.\/supabase\.js['"]/);
});
