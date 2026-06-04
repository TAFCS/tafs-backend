-- Drop the partial unique index on (student_id, fee_type_id, fee_date).
-- This constraint was causing failures when the same fee_type + fee_date combination
-- needs to exist in multiple rows (e.g. re-issued vouchers after deposit reversal,
-- split balance rows that have been cleaned up and re-issued, etc.).
-- There is no business reason to enforce uniqueness here at the DB level;
-- the application already controls fee row lifecycle.

DROP INDEX IF EXISTS "student_fees_unique_regular_head";
ALTER TABLE "student_fees" DROP CONSTRAINT IF EXISTS "student_fees_unique_regular_head";
DROP INDEX IF EXISTS "idx_student_fees_non_discount";
