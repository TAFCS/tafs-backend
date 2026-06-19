-- Widen personal_phone: at least one employee record has two phone numbers
-- joined as "0XXX-XXXXXXX; 0XXX-XXXXXXX" (26 chars), exceeding VARCHAR(20).
ALTER TABLE "employee_profiles" ALTER COLUMN "personal_phone" TYPE VARCHAR(60);
