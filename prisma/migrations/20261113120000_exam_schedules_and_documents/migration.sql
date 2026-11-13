-- TAFSD-510: exam schedules and the admit cards / statements of entry issued from
-- them. Additive only: four new tables, nothing existing changes.

-- CreateTable
CREATE TABLE "exam_schedules" (
    "id" SERIAL NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "academic_year" VARCHAR(10) NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "segment_line" VARCHAR(150),
    "reference_no" VARCHAR(100),
    "dues_cleared_through" DATE NOT NULL,
    "issue_from" DATE,
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "created_by" VARCHAR(100),
    "updated_by" VARCHAR(100),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "exam_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_schedule_classes" (
    "schedule_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,

    CONSTRAINT "exam_schedule_classes_pkey" PRIMARY KEY ("schedule_id","class_id")
);

-- CreateTable
CREATE TABLE "exam_schedule_papers" (
    "id" SERIAL NOT NULL,
    "schedule_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "paper_date" DATE NOT NULL,
    "time_text" VARCHAR(60) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "code" VARCHAR(40),
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "exam_schedule_papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_documents" (
    "id" SERIAL NOT NULL,
    "schedule_id" INTEGER NOT NULL,
    "student_id" INTEGER NOT NULL,
    "doc_type" VARCHAR(30) NOT NULL,
    "serial_no" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "section_id" INTEGER,
    "issued_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" VARCHAR(100) NOT NULL,
    "print_count" INTEGER NOT NULL DEFAULT 1,
    "last_printed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dues_outstanding" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "override_reason" TEXT,
    "overridden_by" VARCHAR(100),

    CONSTRAINT "exam_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exam_schedules_campus_id_academic_year_idx" ON "exam_schedules"("campus_id", "academic_year");

-- CreateIndex
CREATE INDEX "exam_schedule_papers_schedule_id_class_id_idx" ON "exam_schedule_papers"("schedule_id", "class_id");

-- CreateIndex
CREATE INDEX "exam_documents_student_id_idx" ON "exam_documents"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_documents_schedule_id_student_id_key" ON "exam_documents"("schedule_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_documents_schedule_id_serial_no_key" ON "exam_documents"("schedule_id", "serial_no");

-- AddForeignKey
ALTER TABLE "exam_schedules" ADD CONSTRAINT "exam_schedules_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_schedule_classes" ADD CONSTRAINT "exam_schedule_classes_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "exam_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_schedule_classes" ADD CONSTRAINT "exam_schedule_classes_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_schedule_papers" ADD CONSTRAINT "exam_schedule_papers_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "exam_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_schedule_papers" ADD CONSTRAINT "exam_schedule_papers_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_documents" ADD CONSTRAINT "exam_documents_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "exam_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_documents" ADD CONSTRAINT "exam_documents_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_documents" ADD CONSTRAINT "exam_documents_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

