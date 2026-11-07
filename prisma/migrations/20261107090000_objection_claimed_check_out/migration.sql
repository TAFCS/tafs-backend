-- TAFSD-490: a whole-day objection claims both the clock-in (claimed_time)
-- and the clock-out of that day.
ALTER TABLE "attendance_objections" ADD COLUMN IF NOT EXISTS "claimed_check_out_time" TIMESTAMP(6);
