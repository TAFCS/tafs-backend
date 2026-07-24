-- AlterTable
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "complementary_reason" VARCHAR(500);
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "complementary_until" DATE;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "fee_endowment_reason" VARCHAR(500);
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "fee_endowment_until" DATE;
