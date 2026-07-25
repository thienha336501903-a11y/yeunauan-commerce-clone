BEGIN;

DROP INDEX IF EXISTS public.idx_orders_learning_entitlement;
DROP INDEX IF EXISTS public.idx_courses_learning_course_slug;

ALTER TABLE public.orders
  DROP COLUMN IF EXISTS learning_course_slug;

ALTER TABLE public.courses
  DROP COLUMN IF EXISTS learning_course_slug;

COMMIT;
