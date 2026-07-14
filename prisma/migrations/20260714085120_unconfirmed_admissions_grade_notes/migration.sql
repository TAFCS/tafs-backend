-- Quick Registration now captures the intended class/grade and an internal
-- admin note so both carry through once the record is later confirmed into
-- a real student + student_admissions row.
ALTER TABLE "unconfirmed_admissions" ADD COLUMN "academic_system" VARCHAR(20);
ALTER TABLE "unconfirmed_admissions" ADD COLUMN "requested_grade" VARCHAR(20);
ALTER TABLE "unconfirmed_admissions" ADD COLUMN "admin_notes" TEXT;
