-- Fix bulk_voucher_jobs columns
-- Drop old plural array columns and add singular integer columns to match Prisma schema

ALTER TABLE "bulk_voucher_jobs" ADD COLUMN IF NOT EXISTS "campus_id" INTEGER;
ALTER TABLE "bulk_voucher_jobs" ADD COLUMN IF NOT EXISTS "class_id" INTEGER;
ALTER TABLE "bulk_voucher_jobs" ADD COLUMN IF NOT EXISTS "section_id" INTEGER;

-- Migrate data if possible (safe because we check for existence in previous steps)
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bulk_voucher_jobs' AND column_name='campus_ids') THEN
        UPDATE "bulk_voucher_jobs" SET "campus_id" = "campus_ids"[1] WHERE "campus_id" IS NULL AND "campus_ids" IS NOT NULL AND array_length("campus_ids", 1) > 0;
        ALTER TABLE "bulk_voucher_jobs" DROP COLUMN "campus_ids";
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bulk_voucher_jobs' AND column_name='class_ids') THEN
        UPDATE "bulk_voucher_jobs" SET "class_id" = "class_ids"[1] WHERE "class_id" IS NULL AND "class_ids" IS NOT NULL AND array_length("class_ids", 1) > 0;
        ALTER TABLE "bulk_voucher_jobs" DROP COLUMN "class_ids";
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bulk_voucher_jobs' AND column_name='section_ids') THEN
        UPDATE "bulk_voucher_jobs" SET "section_id" = "section_ids"[1] WHERE "section_id" IS NULL AND "section_ids" IS NOT NULL AND array_length("section_ids", 1) > 0;
        ALTER TABLE "bulk_voucher_jobs" DROP COLUMN "section_ids";
    END IF;
END $$;

-- Set NOT NULL and add Foreign Key
-- If campus_id is still NULL (no data to migrate), we might need a default or just let it fail if it's a clean DB.
-- But the schema says it's NOT NULL.
UPDATE "bulk_voucher_jobs" SET "campus_id" = (SELECT id FROM "campuses" LIMIT 1) WHERE "campus_id" IS NULL;
ALTER TABLE "bulk_voucher_jobs" ALTER COLUMN "campus_id" SET NOT NULL;

ALTER TABLE "bulk_voucher_jobs" ADD CONSTRAINT "bulk_voucher_jobs_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Add index
CREATE INDEX IF NOT EXISTS "idx_bulk_jobs_campus" ON "bulk_voucher_jobs"("campus_id");
