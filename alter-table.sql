-- Alter unconfirmed_admissions table to use JSON array for multiple guardians
ALTER TABLE "unconfirmed_admissions" 
DROP COLUMN IF EXISTS "guardian_name",
DROP COLUMN IF EXISTS "guardian_relation",
DROP COLUMN IF EXISTS "guardian_cnic",
ADD COLUMN "guardians" JSONB DEFAULT '[]'::jsonb;
