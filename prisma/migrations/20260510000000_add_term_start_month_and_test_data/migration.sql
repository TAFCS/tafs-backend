-- Add term_start_month to classes table
-- Default 8 = August (standard Aug-Jul academic term)
-- Override to 4 for April-March term classes

ALTER TABLE "classes" ADD COLUMN IF NOT EXISTS "term_start_month" INTEGER NOT NULL DEFAULT 8;

-- Set April-March term for class IDs 15–19
UPDATE "classes" SET "term_start_month" = 4 WHERE "id" IN (15, 16, 17, 18, 19);

-- ─── Test data for student cc=44 ─────────────────────────────────────────────

-- Ensure class 1 is linked to campus 2
INSERT INTO "campus_classes" ("campus_id", "class_id", "is_active")
VALUES (2, 1, true)
ON CONFLICT ON CONSTRAINT "campus_classes_unique" DO NOTHING;

-- Ensure section 1 is linked to campus 2 + class 1
INSERT INTO "campus_sections" ("campus_id", "class_id", "section_id", "is_active")
VALUES (2, 1, 1, true)
ON CONFLICT ON CONSTRAINT "campus_sections_unique" DO NOTHING;

-- Class fee schedule for class 1 at campus 2, academic year 2025-26
-- fee_type 1 (Tuition): 1000 PKR/month
INSERT INTO "class_fee_schedule" ("class_id", "fee_id", "amount", "campus_id", "academic_year")
VALUES (1, 1, 1000.00, 2, '2025-26')
ON CONFLICT ("class_id", "fee_id", "campus_id", "academic_year") DO UPDATE SET "amount" = 1000.00;

-- fee_type 2: 20000 PKR (appears in April per that fee type's breakup)
INSERT INTO "class_fee_schedule" ("class_id", "fee_id", "amount", "campus_id", "academic_year")
VALUES (1, 2, 20000.00, 2, '2025-26')
ON CONFLICT ("class_id", "fee_id", "campus_id", "academic_year") DO UPDATE SET "amount" = 20000.00;

-- Move test student cc=44 to campus 2, class 1, section 1
UPDATE "students"
SET "campus_id" = 2, "class_id" = 1, "section_id" = 1
WHERE "cc" = 44;
