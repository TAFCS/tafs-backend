-- CreateEnum
CREATE TYPE "StaffAttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'HALF_DAY', 'EXCUSED');

-- CreateTable
CREATE TABLE "attendance_staff_daily" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "status" "StaffAttendanceStatus" NOT NULL,
    "notes" VARCHAR(500),
    "marked_by" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "attendance_staff_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_staff_daily_employee_id_date_key" ON "attendance_staff_daily"("employee_id", "date");

-- CreateIndex
CREATE INDEX "attendance_staff_daily_date_campus_id_idx" ON "attendance_staff_daily"("date", "campus_id");

-- AddForeignKey
ALTER TABLE "attendance_staff_daily" ADD CONSTRAINT "attendance_staff_daily_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_staff_daily" ADD CONSTRAINT "attendance_staff_daily_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
