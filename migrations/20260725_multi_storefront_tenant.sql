BEGIN;

ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS sales_site TEXT;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS sales_site TEXT,
  ADD COLUMN IF NOT EXISTS sales_host TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS price_snapshot TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'courses_sales_site_check'
      AND conrelid = 'public.courses'::regclass
  ) THEN
    ALTER TABLE public.courses
      ADD CONSTRAINT courses_sales_site_check
      CHECK (sales_site IS NULL OR sales_site IN ('yeunauan', 'yeubep'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_sales_site_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_sales_site_check
      CHECK (sales_site IS NULL OR sales_site IN ('yeunauan', 'yeubep'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_courses_sales_site_active_sort
  ON public.courses (sales_site, active, sort_order);
CREATE INDEX IF NOT EXISTS idx_orders_sales_site_course_status
  ON public.orders (sales_site, course_slug, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_sales_site_idempotency
  ON public.orders (sales_site, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.courses.sales_site IS
  'Tenant storefront: yeunauan or yeubep. NULL is interpreted by the application as legacy yeunauan.';
COMMENT ON COLUMN public.orders.sales_site IS
  'Order source tenant. NULL is interpreted by the application as legacy yeunauan.';

COMMIT;
