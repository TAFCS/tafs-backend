-- TAFSD-363: per-weekday staff timings, and timings recorded on progression periods.

-- CreateTable
CREATE TABLE "employee_day_timings" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "reporting_time" TIME(0),
    "leaving_time" TIME(0),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_day_timings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_day_timings_employee_id_day_of_week_key" ON "employee_day_timings"("employee_id", "day_of_week");

-- AddForeignKey
ALTER TABLE "employee_day_timings" ADD CONSTRAINT "employee_day_timings_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "employee_progression_periods" ADD COLUMN "timings" JSONB;
