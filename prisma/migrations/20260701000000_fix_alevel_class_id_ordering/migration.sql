-- =============================================================================
-- Migration: Fix A-Level class ID ordering (DB-01)
-- Date: 2026-07-01
--
-- Problem:
--   The classes table had a gap at id=20, making the A-Level block look like:
--     id=19  X  (Secondary)
--     id=20  <empty>
--     id=21  AS Level
--     id=22  A2 Level
--
-- Fix:
--   Close the gap by shifting both A-Level rows down by 1:
--     id=20  AS Level  (was 21)
--     id=21  A2 Level  (was 22)
--
-- Strategy:
--   Because classes.id is a PK and FK constraints are ON UPDATE NO ACTION,
--   we use INSERT-new → UPDATE-references → DELETE-old for each row.
--   This never violates FK constraints (the old PK always exists while child
--   rows are still pointing to it, and the new PK exists before we point
--   children at it).
--
--   All inside one transaction — if anything fails, everything rolls back.
--
-- Affected tables (FK columns):
--   students (class_id, graduated_from_class_id)
--   vouchers (class_id)
--   campus_classes (class_id)
--   campus_sections (class_id)
--   class_fee_schedule (class_id)
--   class_attendance_modes (class_id)
--   class_check_in_schedules (class_id)
--   academic_calendar_days (class_id)
--   attendance_roll_sessions (class_id)
--   employee_class_section_assignments (class_id)
--
-- Affected tables (Int[] array columns — no FK):
--   users.allowed_class_ids
--   bulk_voucher_jobs.class_ids
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 1: Move AS  21 → 20
-- id=20 is currently empty (the gap), so this is safe immediately.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a. Insert AS at its new id=20
INSERT INTO "classes" ("id", "description", "class_code", "academic_system", "term_start_month")
SELECT 20, "description", "class_code", "academic_system", "term_start_month"
FROM "classes"
WHERE "id" = 21;

-- 1b. Update every FK reference: 21 → 20
UPDATE "students"                          SET "class_id" = 20             WHERE "class_id" = 21;
UPDATE "students"                          SET "graduated_from_class_id" = 20 WHERE "graduated_from_class_id" = 21;
UPDATE "vouchers"                          SET "class_id" = 20             WHERE "class_id" = 21;
UPDATE "campus_classes"                    SET "class_id" = 20             WHERE "class_id" = 21;
UPDATE "campus_sections"                   SET "class_id" = 20             WHERE "class_id" = 21;
UPDATE "class_fee_schedule"                SET "class_id" = 20             WHERE "class_id" = 21;
UPDATE "class_attendance_modes"            SET "class_id" = 20             WHERE "class_id" = 21;
UPDATE "class_check_in_schedules"          SET "class_id" = 20             WHERE "class_id" = 21;
UPDATE "academic_calendar_days"            SET "class_id" = 20             WHERE "class_id" = 21;
UPDATE "attendance_roll_sessions"          SET "class_id" = 20             WHERE "class_id" = 21;
UPDATE "employee_class_section_assignments" SET "class_id" = 20            WHERE "class_id" = 21;

-- 1c. Update Int[] array columns (no FK — must be done manually)
UPDATE "users"
  SET "allowed_class_ids" = array_replace("allowed_class_ids", 21, 20)
  WHERE 21 = ANY("allowed_class_ids");

UPDATE "bulk_voucher_jobs"
  SET "class_ids" = array_replace("class_ids", 21, 20)
  WHERE 21 = ANY("class_ids");

-- 1d. Delete the now-orphaned old AS row
DELETE FROM "classes" WHERE "id" = 21;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2: Move A2  22 → 21
-- id=21 is now free (deleted above), so this is safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- 2a. Insert A2 at its new id=21
INSERT INTO "classes" ("id", "description", "class_code", "academic_system", "term_start_month")
SELECT 21, "description", "class_code", "academic_system", "term_start_month"
FROM "classes"
WHERE "id" = 22;

-- 2b. Update every FK reference: 22 → 21
UPDATE "students"                          SET "class_id" = 21             WHERE "class_id" = 22;
UPDATE "students"                          SET "graduated_from_class_id" = 21 WHERE "graduated_from_class_id" = 22;
UPDATE "vouchers"                          SET "class_id" = 21             WHERE "class_id" = 22;
UPDATE "campus_classes"                    SET "class_id" = 21             WHERE "class_id" = 22;
UPDATE "campus_sections"                   SET "class_id" = 21             WHERE "class_id" = 22;
UPDATE "class_fee_schedule"                SET "class_id" = 21             WHERE "class_id" = 22;
UPDATE "class_attendance_modes"            SET "class_id" = 21             WHERE "class_id" = 22;
UPDATE "class_check_in_schedules"          SET "class_id" = 21             WHERE "class_id" = 22;
UPDATE "academic_calendar_days"            SET "class_id" = 21             WHERE "class_id" = 22;
UPDATE "attendance_roll_sessions"          SET "class_id" = 21             WHERE "class_id" = 22;
UPDATE "employee_class_section_assignments" SET "class_id" = 21            WHERE "class_id" = 22;

-- 2c. Update Int[] array columns
UPDATE "users"
  SET "allowed_class_ids" = array_replace("allowed_class_ids", 22, 21)
  WHERE 22 = ANY("allowed_class_ids");

UPDATE "bulk_voucher_jobs"
  SET "class_ids" = array_replace("class_ids", 22, 21)
  WHERE 22 = ANY("class_ids");

-- 2d. Delete the now-orphaned old A2 row
DELETE FROM "classes" WHERE "id" = 22;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 3: Reset the classes sequence to resume after id=21
-- ─────────────────────────────────────────────────────────────────────────────
SELECT setval(pg_get_serial_sequence('"classes"', 'id'), 21);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sanity check (will cause rollback if violated)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Confirm AS is at 20, A2 is at 21
  IF NOT EXISTS (SELECT 1 FROM "classes" WHERE "id" = 20 AND "class_code" = 'AS') THEN
    RAISE EXCEPTION 'Sanity check failed: AS not found at id=20';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "classes" WHERE "id" = 21 AND "class_code" = 'A2') THEN
    RAISE EXCEPTION 'Sanity check failed: A2 not found at id=21';
  END IF;
  -- Confirm old IDs are gone
  IF EXISTS (SELECT 1 FROM "classes" WHERE "id" IN (22)) THEN
    RAISE EXCEPTION 'Sanity check failed: old class id=22 still exists';
  END IF;
  -- Confirm no students left pointing at old IDs
  IF EXISTS (SELECT 1 FROM "students" WHERE "class_id" IN (22)) THEN
    RAISE EXCEPTION 'Sanity check failed: students still reference old class IDs';
  END IF;
  -- Confirm no vouchers left pointing at old IDs
  IF EXISTS (SELECT 1 FROM "vouchers" WHERE "class_id" IN (22)) THEN
    RAISE EXCEPTION 'Sanity check failed: vouchers still reference old class IDs';
  END IF;
  RAISE NOTICE 'All sanity checks passed.';
END $$;

COMMIT;
