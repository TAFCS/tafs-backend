-- TAFSD-556: flag biometric scans by students who are no longer enrolled
-- (LEFT, EXPELLED or GRADUATED when they scanned). One row per scan; the scan's
-- normal processing is unchanged. The scan processor tolerates this table not
-- existing yet, so the code may deploy before this migration is applied.

-- CreateTable
CREATE TABLE "attendance_non_enrolled_scans" (
    "id" SERIAL NOT NULL,
    "scan_id" INTEGER NOT NULL,
    "student_cc" INTEGER NOT NULL,
    "student_status" "student_status" NOT NULL,
    "left_at" TIMESTAMP(6),
    "campus_id" INTEGER,
    "device_sn" VARCHAR(50) NOT NULL,
    "device_pin" VARCHAR(50) NOT NULL,
    "scan_time" TIMESTAMP(6) NOT NULL,
    "attendance_date" DATE NOT NULL,
    "alerted_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_non_enrolled_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_non_enrolled_scans_scan_id_key" ON "attendance_non_enrolled_scans"("scan_id");

-- CreateIndex
CREATE INDEX "attendance_non_enrolled_scans_attendance_date_campus_id_idx" ON "attendance_non_enrolled_scans"("attendance_date", "campus_id");

-- CreateIndex
CREATE INDEX "attendance_non_enrolled_scans_student_cc_attendance_date_idx" ON "attendance_non_enrolled_scans"("student_cc", "attendance_date");

-- AddForeignKey
ALTER TABLE "attendance_non_enrolled_scans" ADD CONSTRAINT "attendance_non_enrolled_scans_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "zk_attendance_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_non_enrolled_scans" ADD CONSTRAINT "attendance_non_enrolled_scans_student_cc_fkey" FOREIGN KEY ("student_cc") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_non_enrolled_scans" ADD CONSTRAINT "attendance_non_enrolled_scans_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Only one flag per student per day may carry alerted_at: claiming it is how the
-- processor sends the alert once per student per day, even with two scans racing.
-- Copied into test/db/db-only-objects.sql.
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_non_enrolled_scans_one_alert_per_day"
  ON "attendance_non_enrolled_scans"("student_cc", "attendance_date") WHERE "alerted_at" IS NOT NULL;
