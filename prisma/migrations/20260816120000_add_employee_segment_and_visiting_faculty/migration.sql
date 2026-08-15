-- Add optional per-employee segment assignment (SENIORS/JUNIORS/TAFSOL/TAFSAL/SECONDARY/PRE-PRIMARY)
ALTER TABLE "employee_profiles" ADD COLUMN IF NOT EXISTS "segment_id" INTEGER;

ALTER TABLE "employee_profiles"
  ADD CONSTRAINT "employee_profiles_segment_id_fkey"
  FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "employee_profiles_segment_id_idx" ON "employee_profiles"("segment_id");

-- Add VISITING FACULTY as its own ACADEMICS subcategory, code 05.
-- SPORTS_COACH keeps its existing code/employees untouched — this is a
-- new, separate category for staff who were previously mislabeled.
INSERT INTO "staff_categories" ("department_id", "code", "name", "description", "employee_code_dep")
SELECT d.id, 'VISITING_FACULTY', 'VISITING FACULTY', 'Visiting/guest teaching faculty', '05'
FROM "departments" d
WHERE d.name = 'ACADEMICS'
  AND NOT EXISTS (
    SELECT 1 FROM "staff_categories" sc WHERE sc.department_id = d.id AND sc.code = 'VISITING_FACULTY'
  );
