-- TAFSD-484: breaks entered on a manual staff attendance override.
ALTER TABLE "attendance_staff_daily" ADD COLUMN "manual_breaks" JSONB;
