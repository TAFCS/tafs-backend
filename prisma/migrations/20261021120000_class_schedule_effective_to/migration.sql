-- TAFSD-385: temporary school timings. A row with effective_to stops applying
-- after that day and the previous (normal) row takes over again.
ALTER TABLE "class_check_in_schedules" ADD COLUMN "effective_to" DATE;
