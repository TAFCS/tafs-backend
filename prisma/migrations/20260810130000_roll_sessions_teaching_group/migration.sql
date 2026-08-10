-- Roll-call sessions can now be scoped to a teaching group (cross-section
-- subject class) instead of a home section, so the roster reflects the
-- students actually enrolled in that subject rather than the whole section.
ALTER TABLE "attendance_roll_sessions" ALTER COLUMN "section_id" DROP NOT NULL;
ALTER TABLE "attendance_roll_sessions" ADD COLUMN "teaching_group_id" INTEGER;

ALTER TABLE "attendance_roll_sessions" ADD CONSTRAINT "attendance_roll_sessions_teaching_group_id_fkey"
  FOREIGN KEY ("teaching_group_id") REFERENCES "teaching_groups"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

DROP INDEX IF EXISTS "attendance_roll_sessions_scope_period_slot_key";
CREATE UNIQUE INDEX "attendance_roll_sessions_scope_period_slot_key" ON "attendance_roll_sessions"(
  "campus_id", "class_id", "section_id", "teaching_group_id", "session_date", "period", "timetable_slot_id"
);

CREATE INDEX "attendance_roll_sessions_teaching_group_id_idx" ON "attendance_roll_sessions"("teaching_group_id");
