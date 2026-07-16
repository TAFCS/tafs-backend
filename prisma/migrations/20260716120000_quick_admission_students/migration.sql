-- AlterEnum
ALTER TYPE "student_status" ADD VALUE IF NOT EXISTS 'QUICK_ADMISSION';

-- AlterTable
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "quick_admission_meta" JSONB;
