BEGIN;

ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS learning_course_slug TEXT;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS learning_course_slug TEXT;

CREATE INDEX IF NOT EXISTS idx_courses_learning_course_slug
  ON public.courses (learning_course_slug)
  WHERE learning_course_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_learning_entitlement
  ON public.orders (learning_course_slug, customer_email, status)
  WHERE learning_course_slug IS NOT NULL;

COMMENT ON COLUMN public.courses.learning_course_slug IS
  'Canonical LMS/Portal slug. NULL means use this course slug. One-level aliases only.';
COMMENT ON COLUMN public.orders.learning_course_slug IS
  'Immutable canonical LMS/Portal slug snapshot at order creation. NULL means legacy course_slug.';

COMMIT;
