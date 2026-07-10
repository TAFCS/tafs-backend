-- Split employee code into department prefix and sequence number (e.g. 03-5256 -> dep 03, number 5256)
ALTER TABLE "employee_profiles"
    ADD COLUMN IF NOT EXISTS "employee_code_dep" VARCHAR(10),
    ADD COLUMN IF NOT EXISTS "employee_code_number" VARCHAR(20);

-- Backfill from existing XX-NNNN style codes
UPDATE "employee_profiles"
SET
    "employee_code_dep" = (regexp_match("employee_code", '^(\d{2})-'))[1],
    "employee_code_number" = (regexp_match("employee_code", '^\d{2}-(.+)$'))[1]
WHERE "employee_code" ~ '^\d{2}-'
  AND ("employee_code_dep" IS NULL OR "employee_code_number" IS NULL);
