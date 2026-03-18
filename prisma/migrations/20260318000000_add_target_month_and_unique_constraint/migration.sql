-- ============================================================
-- Migration: Add target_month column and unique constraint to student_fees
-- Date: 2026-03-18
--
-- Rationale:
--   target_month was added to the schema but never formally migrated.
--   The ON CONFLICT clause in fees.service.ts requires the unique constraint
--   on (student_id, fee_type_id, month, academic_year) to exist in the DB.
-- ============================================================

-- Step 1: Add target_month column if it doesn't already exist.
ALTER TABLE public.student_fees
    ADD COLUMN IF NOT EXISTS target_month INT;

-- Step 2: Back-fill: set target_month = month for existing rows where it is NULL.
UPDATE public.student_fees
SET target_month = month
WHERE target_month IS NULL;

-- Step 3: Enforce NOT NULL now that all rows have a value.
ALTER TABLE public.student_fees
    ALTER COLUMN target_month SET NOT NULL;

-- Step 4: Remove duplicate rows, keeping only the one with the highest id
--   for each (student_id, fee_type_id, month, academic_year) group.
--   This is safe because the duplicates are logically the same fee record;
--   we preserve the most-recently inserted entry.
DELETE FROM public.student_fees
WHERE id NOT IN (
    SELECT MAX(id)
    FROM public.student_fees
    GROUP BY student_id, fee_type_id, month, academic_year
);

-- Step 5: Drop the unique constraint if it already exists (idempotency).
ALTER TABLE public.student_fees
    DROP CONSTRAINT IF EXISTS "student_fees_student_id_fee_type_id_month_academic_year_key";

-- Step 6: Create the unique constraint that the ON CONFLICT clause relies on.
ALTER TABLE public.student_fees
    ADD CONSTRAINT "student_fees_student_id_fee_type_id_month_academic_year_key"
    UNIQUE (student_id, fee_type_id, month, academic_year);

