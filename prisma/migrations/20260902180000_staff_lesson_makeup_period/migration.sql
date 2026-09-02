-- Allow makeup on arbitrary block without a recurring timetable slot.
ALTER TABLE "staff_lesson_reschedules" ADD COLUMN "makeup_period" INTEGER;
