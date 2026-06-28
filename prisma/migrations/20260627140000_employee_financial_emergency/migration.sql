ALTER TABLE "employee_profiles"
  ADD COLUMN IF NOT EXISTS "account_number" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "bank_name" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "emergency_contact_name" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "emergency_contact_phone" VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "emergency_contact_relationship" VARCHAR(50);
