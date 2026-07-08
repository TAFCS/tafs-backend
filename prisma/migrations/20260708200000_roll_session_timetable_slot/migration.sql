-- DropIndex
DROP INDEX "attendance_roll_sessions_campus_id_class_id_section_id_session_date_period_key";

-- AlterTable
ALTER TABLE "attendance_roll_sessions" ADD COLUMN "timetable_slot_id" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "attendance_roll_sessions_scope_period_slot_key" ON "attendance_roll_sessions"("campus_id", "class_id", "section_id", "session_date", "period", "timetable_slot_id");

-- AddForeignKey
ALTER TABLE "attendance_roll_sessions" ADD CONSTRAINT "attendance_roll_sessions_timetable_slot_id_fkey" FOREIGN KEY ("timetable_slot_id") REFERENCES "timetable_slots"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
