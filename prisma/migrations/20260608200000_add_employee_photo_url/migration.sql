-- Add photo_url column to employee_profiles for storing uploaded profile photo URLs
ALTER TABLE "employee_profiles" ADD COLUMN IF NOT EXISTS "photo_url" TEXT;
