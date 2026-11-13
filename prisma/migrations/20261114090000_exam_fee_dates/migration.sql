-- TAFSD-510: the fee date a schedule checks dues against becomes an exact date
-- that can be edited, and a student can be given their own.

-- Rename, not drop-and-add, so any schedule already saved keeps its date.
ALTER TABLE "exam_schedules" RENAME COLUMN "dues_cleared_through" TO "fee_date";

-- The fee date each document was checked against when it was issued.
ALTER TABLE "exam_documents" ADD COLUMN "fee_date" DATE;

-- CreateTable
CREATE TABLE "exam_schedule_fee_dates" (
    "schedule_id" INTEGER NOT NULL,
    "student_id" INTEGER NOT NULL,
    "fee_date" DATE NOT NULL,
    "reason" VARCHAR(500),
    "set_by" VARCHAR(100) NOT NULL,
    "set_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_schedule_fee_dates_pkey" PRIMARY KEY ("schedule_id","student_id")
);

-- CreateIndex
CREATE INDEX "exam_schedule_fee_dates_student_id_idx" ON "exam_schedule_fee_dates"("student_id");

-- AddForeignKey
ALTER TABLE "exam_schedule_fee_dates" ADD CONSTRAINT "exam_schedule_fee_dates_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "exam_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_schedule_fee_dates" ADD CONSTRAINT "exam_schedule_fee_dates_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE;
