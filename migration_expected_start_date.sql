-- Add expected opening date for courses.
-- Run on the production courses database.

ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS expected_start_date DATE NULL;

UPDATE courses
SET expected_start_date = (raw_data->>'expectedStartDate')::date
WHERE expected_start_date IS NULL
  AND raw_data ? 'expectedStartDate'
  AND (raw_data->>'expectedStartDate') ~ '^\d{4}-\d{2}-\d{2}$';
