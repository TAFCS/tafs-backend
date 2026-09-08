-- AlterForeignKey
ALTER TABLE "class_session_reschedules" DROP CONSTRAINT IF EXISTS "class_session_reschedules_source_timetable_slot_id_fkey";

-- AlterForeignKey
ALTER TABLE "class_session_reschedules" DROP CONSTRAINT IF EXISTS "class_session_reschedules_makeup_timetable_slot_id_fkey";

-- AlterForeignKey
ALTER TABLE "staff_lesson_reschedules" DROP CONSTRAINT IF EXISTS "staff_lesson_reschedules_source_timetable_slot_id_fkey";

-- AlterForeignKey
ALTER TABLE "staff_lesson_reschedules" DROP CONSTRAINT IF EXISTS "staff_lesson_reschedules_makeup_timetable_slot_id_fkey";

-- AddForeignKey
ALTER TABLE "class_session_reschedules" ADD CONSTRAINT "class_session_reschedules_source_timetable_slot_id_fkey" FOREIGN KEY ("source_timetable_slot_id") REFERENCES "timetable_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_session_reschedules" ADD CONSTRAINT "class_session_reschedules_makeup_timetable_slot_id_fkey" FOREIGN KEY ("makeup_timetable_slot_id") REFERENCES "timetable_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_lesson_reschedules" ADD CONSTRAINT "staff_lesson_reschedules_source_timetable_slot_id_fkey" FOREIGN KEY ("source_timetable_slot_id") REFERENCES "timetable_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_lesson_reschedules" ADD CONSTRAINT "staff_lesson_reschedules_makeup_timetable_slot_id_fkey" FOREIGN KEY ("makeup_timetable_slot_id") REFERENCES "timetable_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
