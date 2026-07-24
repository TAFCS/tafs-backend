-- Graduated students previously had no recorded graduation date, only a
-- flag row's reminder_date as an implicit proxy. Add an explicit column so
-- the directory, profile, and family app can show "graduated from X on Y"
-- unambiguously.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "graduated_at" DATE;
