-- Staff category scoping for staff calendar holidays
ALTER TABLE "academic_calendar_days"
  ADD COLUMN IF NOT EXISTS "staff_category" "StaffCategory";

-- Allow multiple scoped entries per campus/date (drop overly broad unique if present)
DROP INDEX IF EXISTS "academic_calendar_days_campus_id_date_applies_to_key";

CREATE INDEX IF NOT EXISTS "academic_calendar_days_staff_category_idx"
  ON "academic_calendar_days"("staff_category");

CREATE UNIQUE INDEX IF NOT EXISTS "academic_calendar_days_scope_key"
  ON "academic_calendar_days"(
    "campus_id",
    "date",
    "applies_to",
    "class_id",
    "section_id",
    "department_id",
    "staff_category",
    "employee_id"
  );
