-- CreateEnum
CREATE TYPE "RollSessionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "RollRecordStatus" AS ENUM ('PRESENT', 'ABSENT');

-- CreateTable
CREATE TABLE "attendance_roll_sessions" (
    "id" SERIAL NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "section_id" INTEGER NOT NULL,
    "session_date" DATE NOT NULL,
    "period" INTEGER NOT NULL DEFAULT 1,
    "status" "RollSessionStatus" NOT NULL DEFAULT 'DRAFT',
    "skip_reason" VARCHAR(500),
    "created_by_id" TEXT,
    "submitted_by_id" TEXT,
    "submitted_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "attendance_roll_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_roll_records" (
    "id" SERIAL NOT NULL,
    "session_id" INTEGER NOT NULL,
    "student_cc" INTEGER NOT NULL,
    "status" "RollRecordStatus" NOT NULL,
    "notes" VARCHAR(255),

    CONSTRAINT "attendance_roll_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_roll_sessions_campus_id_class_id_section_id_session_date_period_key" ON "attendance_roll_sessions"("campus_id", "class_id", "section_id", "session_date", "period");

-- CreateIndex
CREATE INDEX "attendance_roll_sessions_session_date_campus_id_idx" ON "attendance_roll_sessions"("session_date", "campus_id");

-- CreateIndex
CREATE INDEX "attendance_roll_sessions_status_session_date_idx" ON "attendance_roll_sessions"("status", "session_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_roll_records_session_id_student_cc_key" ON "attendance_roll_records"("session_id", "student_cc");

-- CreateIndex
CREATE INDEX "attendance_roll_records_student_cc_idx" ON "attendance_roll_records"("student_cc");

-- AddForeignKey
ALTER TABLE "attendance_roll_sessions" ADD CONSTRAINT "attendance_roll_sessions_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_roll_sessions" ADD CONSTRAINT "attendance_roll_sessions_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_roll_sessions" ADD CONSTRAINT "attendance_roll_sessions_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_roll_sessions" ADD CONSTRAINT "attendance_roll_sessions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_roll_sessions" ADD CONSTRAINT "attendance_roll_sessions_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_roll_records" ADD CONSTRAINT "attendance_roll_records_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "attendance_roll_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_roll_records" ADD CONSTRAINT "attendance_roll_records_student_cc_fkey" FOREIGN KEY ("student_cc") REFERENCES "students"("cc") ON DELETE NO ACTION ON UPDATE NO ACTION;
