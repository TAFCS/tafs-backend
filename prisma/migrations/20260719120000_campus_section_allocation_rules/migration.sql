-- CreateEnum
CREATE TYPE "SectionGenderMode" AS ENUM ('COED', 'BOYS_ONLY', 'GIRLS_ONLY');

-- AlterTable
ALTER TABLE "campus_sections"
ADD COLUMN "student_capacity" INTEGER,
ADD COLUMN "gender_mode" "SectionGenderMode" NOT NULL DEFAULT 'COED';

-- Ensure capacity is either unlimited (NULL) or a positive integer
ALTER TABLE "campus_sections"
ADD CONSTRAINT "campus_sections_student_capacity_positive"
CHECK ("student_capacity" IS NULL OR "student_capacity" > 0);
