import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("tenant migration runs twice and rollback succeeds on an isolated PostgreSQL database", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.courses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      active BOOLEAN DEFAULT true,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE public.orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_slug TEXT NOT NULL,
      status TEXT DEFAULT 'Chờ duyệt'
    );
    INSERT INTO public.courses (slug, title) VALUES ('legacy', 'Legacy');
    INSERT INTO public.orders (course_slug) VALUES ('legacy');
  `);

  const migration = await readFile(resolve(root, "migrations/20260725_multi_storefront_tenant.sql"), "utf8");
  const rollback = await readFile(resolve(root, "migrations/20260725_multi_storefront_tenant_rollback.sql"), "utf8");
  await db.exec(migration);
  await db.exec(migration);

  const legacy = await db.query("SELECT sales_site FROM public.courses WHERE slug = 'legacy'");
  assert.equal(legacy.rows[0].sales_site, null);
  await db.exec("INSERT INTO public.courses (slug, title, sales_site) VALUES ('yb', 'Yeubep', 'yeubep')");
  await assert.rejects(
    db.exec("INSERT INTO public.courses (slug, title, sales_site) VALUES ('bad', 'Bad', 'attacker')"),
    /courses_sales_site_check/
  );
  await db.exec("INSERT INTO public.orders (course_slug, sales_site, idempotency_key) VALUES ('yb', 'yeubep', 'key-1')");
  await assert.rejects(
    db.exec("INSERT INTO public.orders (course_slug, sales_site, idempotency_key) VALUES ('yb', 'yeubep', 'key-1')"),
    /idx_orders_sales_site_idempotency/
  );

  await db.exec(rollback);
  const columns = await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('courses', 'orders')
      AND column_name IN ('sales_site', 'sales_host', 'idempotency_key', 'price_snapshot')
  `);
  assert.equal(columns.rows.length, 0);
  await db.close();
});
