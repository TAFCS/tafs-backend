-- CreateEnum
CREATE TYPE "RollSessionKind" AS ENUM ('REGULAR', 'MAKEUP');

-- CreateEnum
CREATE TYPE "ClassSessionRescheduleStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "attendance_roll_sessions" ADD COLUMN "session_kind" "RollSessionKind" NOT NULL DEFAULT 'REGULAR';
ALTER TABLE "attendance_roll_sessions" ADD COLUMN "reschedule_id" INTEGER;

-- CreateTable
CREATE TABLE "class_session_reschedules" (
    "id" SERIAL NOT NULL,
    "teaching_group_id" INTEGER NOT NULL,
    "source_timetable_slot_id" INTEGER NOT NULL,
    "source_date" DATE NOT NULL,
    "makeup_date" DATE NOT NULL,
    "makeup_period" INTEGER NOT NULL,
    "makeup_timetable_slot_id" INTEGER,
    "makeup_roll_session_id" INTEGER,
    "source_roll_session_id" INTEGER,
    "status" "ClassSessionRescheduleStatus" NOT NULL DEFAULT 'PENDING',
    "created_by_id" TEXT,
    "notes" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "class_session_reschedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "class_session_reschedules_makeup_roll_session_id_key" ON "class_session_reschedules"("makeup_roll_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_session_reschedules_source_roll_session_id_key" ON "class_session_reschedules"("source_roll_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_session_reschedules_source_key" ON "class_session_reschedules"("teaching_group_id", "source_date", "source_timetable_slot_id");

-- CreateIndex
CREATE INDEX "class_session_reschedules_makeup_date_teaching_group_id_idx" ON "class_session_reschedules"("makeup_date", "teaching_group_id");

-- CreateIndex
CREATE INDEX "class_session_reschedules_status_idx" ON "class_session_reschedules"("status");

-- CreateIndex
CREATE INDEX "attendance_roll_sessions_reschedule_id_idx" ON "attendance_roll_sessions"("reschedule_id");

-- AddForeignKey
ALTER TABLE "attendance_roll_sessions" ADD CONSTRAINT "attendance_roll_sessions_reschedule_id_fkey" FOREIGN KEY ("reschedule_id") REFERENCES "class_session_reschedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_session_reschedules" ADD CONSTRAINT "class_session_reschedules_teaching_group_id_fkey" FOREIGN KEY ("teaching_group_id") REFERENCES "teaching_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_session_reschedules" ADD CONSTRAINT "class_session_reschedules_source_timetable_slot_id_fkey" FOREIGN KEY ("source_timetable_slot_id") REFERENCES "timetable_slots"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_session_reschedules" ADD CONSTRAINT "class_session_reschedules_makeup_timetable_slot_id_fkey" FOREIGN KEY ("makeup_timetable_slot_id") REFERENCES "timetable_slots"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_session_reschedules" ADD CONSTRAINT "class_session_reschedules_makeup_roll_session_id_fkey" FOREIGN KEY ("makeup_roll_session_id") REFERENCES "attendance_roll_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_session_reschedules" ADD CONSTRAINT "class_session_reschedules_source_roll_session_id_fkey" FOREIGN KEY ("source_roll_session_id") REFERENCES "attendance_roll_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_session_reschedules" ADD CONSTRAINT "class_session_reschedules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
