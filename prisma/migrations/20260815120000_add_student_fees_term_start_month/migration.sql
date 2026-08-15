-- ============================================================
-- Migration: Add term_start_month to student_fees
-- Date: 2026-08-15
--
-- Rationale:
--   (target_month, academic_year) is ambiguous on its own. "June of 2025-2026"
--   is June 2026 under an Aug-Jul term (Cambridge, term_start_month = 8) but
--   June 2025 under an Apr-Mar term (Secondary VI-X, term_start_month = 4).
--   Every label/sort site resolved that cutoff from whichever class it happened
--   to be rendering through -- the student's or the voucher's *current* class --
--   so a student moved between term systems had their old heads relabelled a
--   year out. The term in force when the head was written is not recorded
--   anywhere: student_fees has neither a class nor a term column.
--
--   This column stores that fact on the head itself.
--
-- Deliberately NULLABLE and left NULL here:
--   Readers fall back to the pre-existing class-derived cutoff when it is NULL,
--   so applying this migration on its own changes no rendering whatsoever.
--   Existing rows are populated separately and reversibly by
--   scripts/backfill-student-fee-term-start-month.ts.
-- ============================================================

ALTER TABLE public.student_fees
    ADD COLUMN IF NOT EXISTS term_start_month SMALLINT;

COMMENT ON COLUMN public.student_fees.term_start_month IS
    'Term start month (8 = Aug-Jul, 4 = Apr-Mar) of the class this head was written under. NULL = unknown; readers fall back to the viewing class.';
