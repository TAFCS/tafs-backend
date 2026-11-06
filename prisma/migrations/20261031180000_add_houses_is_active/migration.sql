-- TAFSD-441: Add is_active column to houses table
ALTER TABLE "houses" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
