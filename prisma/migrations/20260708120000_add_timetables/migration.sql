-- CreateTable
CREATE TABLE "subjects" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(20),
    "name" VARCHAR(100) NOT NULL,
    "academic_system" VARCHAR(20),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetables" (
    "id" SERIAL NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "section_id" INTEGER NOT NULL,
    "academic_year" VARCHAR(10) NOT NULL,
    "effective_from" DATE NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "timetables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_slots" (
    "id" SERIAL NOT NULL,
    "timetable_id" INTEGER NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "block_number" INTEGER NOT NULL,
    "slot_order" INTEGER NOT NULL DEFAULT 1,
    "subject_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "room" VARCHAR(50),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "timetable_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_blocks" (
    "block_number" INTEGER NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "label" VARCHAR(20),

    CONSTRAINT "timetable_blocks_pkey" PRIMARY KEY ("block_number")
);

-- CreateIndex
CREATE UNIQUE INDEX "subjects_name_academic_system_key" ON "subjects"("name", "academic_system");

-- CreateIndex
CREATE INDEX "timetables_campus_id_class_id_section_id_idx" ON "timetables"("campus_id", "class_id", "section_id");

-- CreateIndex
CREATE UNIQUE INDEX "timetables_scope_year_key" ON "timetables"("campus_id", "class_id", "section_id", "academic_year");

-- CreateIndex
CREATE INDEX "timetable_slots_employee_id_day_of_week_idx" ON "timetable_slots"("employee_id", "day_of_week");

-- CreateIndex
CREATE INDEX "timetable_slots_timetable_id_day_of_week_idx" ON "timetable_slots"("timetable_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_cell_key" ON "timetable_slots"("timetable_id", "day_of_week", "block_number", "slot_order");

-- AddForeignKey
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_timetable_id_fkey" FOREIGN KEY ("timetable_id") REFERENCES "timetables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
