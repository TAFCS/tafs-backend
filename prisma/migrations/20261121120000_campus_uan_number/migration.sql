-- TAFSD-549: each campus's UAN phone number, set in Setup > Campuses and printed
-- on the statements of entry and admit cards it issues.

-- AlterTable
ALTER TABLE "campuses" ADD COLUMN "uan_number" VARCHAR(40);
