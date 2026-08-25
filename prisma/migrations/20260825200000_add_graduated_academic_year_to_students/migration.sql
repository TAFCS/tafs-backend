-- Add graduated_academic_year to students.
--
-- graduated_at (DATE) + classes.term_start_month let readers derive which
-- "YYYY-YYYY" academic year a student graduated in, but that derivation runs
-- on graduated_at's UTC calendar date while the school operates on
-- Asia/Karachi (UTC+5). A graduation processed in the small hours of April 1
-- or August 1 Pakistan time can still read as March 31 / July 31 UTC,
-- landing in the wrong academic-year bucket.
--
-- This column stores students.academic_year AT THE MOMENT a student
-- graduates — their last term studied — captured at write time by the two
-- call sites that set status = GRADUATED (students.service.ts changeStatus /
-- processPromotionForStudent), with an optional staff override. Readers then
-- do a plain equality check instead of date math plus a join to
-- classes.term_start_month.
--
-- Cleared alongside graduated_at when a graduated student is reinstated
-- (POST /students/:id/return) — same lifecycle event, undone together.
-- graduated_from_class_id is NOT cleared there (existing behavior, kept as a
-- restore hint), and this column follows graduated_at's lifecycle instead.

ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "graduated_academic_year" VARCHAR(10);

COMMENT ON COLUMN "students"."graduated_academic_year" IS
    'Academic year (YYYY-YYYY) the student was studying in when they graduated, captured at the moment status became GRADUATED (or explicitly chosen by staff). NULL for non-graduated students. Nulled alongside graduated_at on reinstatement.';

-- Backfill: every student currently in GRADUATED status graduated during
-- academic year 2025-2026 (confirmed business fact, not inferred).
UPDATE "students"
SET "graduated_academic_year" = '2025-2026'
WHERE "status" = 'GRADUATED' AND "graduated_academic_year" IS NULL;
