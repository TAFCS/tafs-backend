-- Teaching groups: a subject class (teacher + subject + class-level) that pulls
-- students across home sections, e.g. "AS Maths -- Zubair Jawaid".
CREATE TABLE "teaching_groups" (
    "id" SERIAL NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "academic_year" VARCHAR(10) NOT NULL,
    "label" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "teaching_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "teaching_groups_scope_key" ON "teaching_groups"("campus_id", "class_id", "subject_id", "employee_id", "academic_year");
CREATE INDEX "teaching_groups_class_id_subject_id_idx" ON "teaching_groups"("class_id", "subject_id");

ALTER TABLE "teaching_groups" ADD CONSTRAINT "teaching_groups_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teaching_groups" ADD CONSTRAINT "teaching_groups_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teaching_groups" ADD CONSTRAINT "teaching_groups_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "teaching_groups" ADD CONSTRAINT "teaching_groups_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Student subject-choice enrollment into a teaching group.
CREATE TABLE "student_subject_enrollments" (
    "id" SERIAL NOT NULL,
    "student_id" INTEGER NOT NULL,
    "teaching_group_id" INTEGER NOT NULL,
    "academic_year" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_subject_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "student_subject_enrollments_key" ON "student_subject_enrollments"("student_id", "teaching_group_id", "academic_year");
CREATE INDEX "student_subject_enrollments_teaching_group_id_idx" ON "student_subject_enrollments"("teaching_group_id");

ALTER TABLE "student_subject_enrollments" ADD CONSTRAINT "student_subject_enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_subject_enrollments" ADD CONSTRAINT "student_subject_enrollments_teaching_group_id_fkey" FOREIGN KEY ("teaching_group_id") REFERENCES "teaching_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Generalize timetables to optionally be scoped by a teaching_group instead of a section.
ALTER TABLE "timetables" ALTER COLUMN "section_id" DROP NOT NULL;
ALTER TABLE "timetables" ADD COLUMN "teaching_group_id" INTEGER;

CREATE UNIQUE INDEX "timetables_group_scope_year_key" ON "timetables"("campus_id", "teaching_group_id", "academic_year");

ALTER TABLE "timetables" ADD CONSTRAINT "timetables_teaching_group_id_fkey" FOREIGN KEY ("teaching_group_id") REFERENCES "teaching_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
