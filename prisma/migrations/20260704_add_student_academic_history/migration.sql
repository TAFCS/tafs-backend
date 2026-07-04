-- CreateTable
CREATE TABLE "student_academic_history" (
    "id" SERIAL NOT NULL,
    "student_cc" INTEGER NOT NULL,
    "class_id" INTEGER,
    "section_id" INTEGER,
    "campus_id" INTEGER,
    "academic_year" VARCHAR(10),
    "gr_number" VARCHAR(50),
    "change_type" VARCHAR(30) NOT NULL,
    "changed_by" VARCHAR(255),
    "changed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" VARCHAR(255),

    CONSTRAINT "student_academic_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_academic_history_student_cc_changed_at_idx" ON "student_academic_history"("student_cc", "changed_at" DESC);

-- AddForeignKey
ALTER TABLE "student_academic_history" ADD CONSTRAINT "student_academic_history_student_cc_fkey" FOREIGN KEY ("student_cc") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_academic_history" ADD CONSTRAINT "student_academic_history_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_academic_history" ADD CONSTRAINT "student_academic_history_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_academic_history" ADD CONSTRAINT "student_academic_history_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
