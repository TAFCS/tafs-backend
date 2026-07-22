-- CreateTable
CREATE TABLE "student_progression_periods" (
    "id" SERIAL NOT NULL,
    "student_cc" INTEGER NOT NULL,
    "campus_id" INTEGER,
    "class_id" INTEGER,
    "section_id" INTEGER,
    "house_id" INTEGER,
    "academic_year" VARCHAR(10),
    "gr_number" VARCHAR(50),
    "change_type" VARCHAR(30) NOT NULL,
    "changed_by" VARCHAR(255),
    "notes" VARCHAR(255),
    "valid_from" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(6),

    CONSTRAINT "student_progression_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_progression_periods_student_cc_valid_from_idx" ON "student_progression_periods"("student_cc", "valid_from");

-- Enforce one open (current) period per student
CREATE UNIQUE INDEX "student_progression_periods_one_open_per_student"
  ON "student_progression_periods" ("student_cc")
  WHERE "valid_to" IS NULL;

-- AddForeignKey
ALTER TABLE "student_progression_periods" ADD CONSTRAINT "student_progression_periods_student_cc_fkey" FOREIGN KEY ("student_cc") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_progression_periods" ADD CONSTRAINT "student_progression_periods_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_progression_periods" ADD CONSTRAINT "student_progression_periods_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_progression_periods" ADD CONSTRAINT "student_progression_periods_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_progression_periods" ADD CONSTRAINT "student_progression_periods_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "houses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
