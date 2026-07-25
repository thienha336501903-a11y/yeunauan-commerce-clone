BEGIN;

DROP INDEX IF EXISTS public.idx_orders_sales_site_idempotency;
DROP INDEX IF EXISTS public.idx_orders_sales_site_course_status;
DROP INDEX IF EXISTS public.idx_courses_sales_site_active_sort;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_sales_site_check,
  DROP COLUMN IF EXISTS price_snapshot,
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS sales_host,
  DROP COLUMN IF EXISTS sales_site;

ALTER TABLE public.courses
  DROP CONSTRAINT IF EXISTS courses_sales_site_check,
  DROP COLUMN IF EXISTS sales_site;

COMMIT;
