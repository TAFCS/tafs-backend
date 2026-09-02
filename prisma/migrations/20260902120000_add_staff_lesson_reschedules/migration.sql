-- CreateTable
CREATE TABLE "staff_lesson_reschedules" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "section_id" INTEGER NOT NULL,
    "source_timetable_slot_id" INTEGER NOT NULL,
    "source_date" DATE NOT NULL,
    "makeup_date" DATE NOT NULL,
    "makeup_timetable_slot_id" INTEGER,
    "status" "ClassSessionRescheduleStatus" NOT NULL DEFAULT 'PENDING',
    "created_by_id" TEXT,
    "notes" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "staff_lesson_reschedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_lesson_reschedules_source_key" ON "staff_lesson_reschedules"("source_timetable_slot_id", "source_date");

-- CreateIndex
CREATE INDEX "staff_lesson_reschedules_employee_id_idx" ON "staff_lesson_reschedules"("employee_id");

-- CreateIndex
CREATE INDEX "staff_lesson_reschedules_campus_id_status_idx" ON "staff_lesson_reschedules"("campus_id", "status");

-- CreateIndex
CREATE INDEX "staff_lesson_reschedules_makeup_date_idx" ON "staff_lesson_reschedules"("makeup_date");

-- AddForeignKey
ALTER TABLE "staff_lesson_reschedules" ADD CONSTRAINT "staff_lesson_reschedules_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_lesson_reschedules" ADD CONSTRAINT "staff_lesson_reschedules_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_lesson_reschedules" ADD CONSTRAINT "staff_lesson_reschedules_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_lesson_reschedules" ADD CONSTRAINT "staff_lesson_reschedules_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_lesson_reschedules" ADD CONSTRAINT "staff_lesson_reschedules_source_timetable_slot_id_fkey" FOREIGN KEY ("source_timetable_slot_id") REFERENCES "timetable_slots"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_lesson_reschedules" ADD CONSTRAINT "staff_lesson_reschedules_makeup_timetable_slot_id_fkey" FOREIGN KEY ("makeup_timetable_slot_id") REFERENCES "timetable_slots"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_lesson_reschedules" ADD CONSTRAINT "staff_lesson_reschedules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
