-- Persist who generated a voucher and when, so PDF regenerations reproduce
-- the same footer instead of stamping "TAFSync System" / render-time.
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "generated_by_name" VARCHAR(100);
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "generated_at" TIMESTAMP(6);
