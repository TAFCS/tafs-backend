-- TAFSD-275: split employment status into {status, subtype}.
-- status  = ACTIVE | LEFT | TERMINATED
-- subtype = PERMANENT | NON_PERMANENT | FAMILY  (only meaningful when status = ACTIVE)
--
-- Backfill decided by Aawaiz 2026-10-08:
--   current ACTIVE      -> status ACTIVE,     subtype NON_PERMANENT
--   current PERMANENT   -> status ACTIVE,     subtype NON_PERMANENT  (admins re-mark promotions later; PERMANENT bucket deliberately empty)
--   current FAMILY      -> status ACTIVE,     subtype FAMILY
--   current LEFT        -> status LEFT,       subtype NULL
--   current TERMINATED  -> status TERMINATED, subtype NULL
--
-- The subtype column is named `employment_subtype` (not `employment_type`)
-- because the existing `employment_type` varchar column already stores a
-- free-form job-type label used by salary increments / employee progression /
-- the master excel export. Renaming the legacy column is out of scope.
--
-- The Postgres enum type `EmployeeStatus` keeps the old PERMANENT and FAMILY
-- values after this migration — no row references them, but dropping an enum
-- value is a separate migration (next release) once the whole fleet (API +
-- schedulers + jobs) is confirmed to be running the new code.
--
-- `employee_profiles.is_permanent_employee` is intentionally untouched — it
-- drives leave policy and will stay the source of truth until a follow-up
-- pass reconciles it with `employment_subtype`.

-- 1. New enum for the subtype
CREATE TYPE "EmploymentSubtype" AS ENUM ('PERMANENT', 'NON_PERMANENT', 'FAMILY');

-- 2. Nullable column on the employee profile
ALTER TABLE "employee_profiles"
  ADD COLUMN "employment_subtype" "EmploymentSubtype";

-- 3. Backfill employment_subtype from the current (pre-collapse) employment_status
UPDATE "employee_profiles"
  SET "employment_subtype" = 'NON_PERMANENT'
  WHERE "employment_status" IN ('ACTIVE', 'PERMANENT');

UPDATE "employee_profiles"
  SET "employment_subtype" = 'FAMILY'
  WHERE "employment_status" = 'FAMILY';

-- 4. Collapse employment_status: PERMANENT and FAMILY both become ACTIVE
UPDATE "employee_profiles"
  SET "employment_status" = 'ACTIVE'
  WHERE "employment_status" IN ('PERMANENT', 'FAMILY');
