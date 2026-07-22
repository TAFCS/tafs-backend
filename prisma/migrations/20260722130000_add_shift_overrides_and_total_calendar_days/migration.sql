-- AlterTable
ALTER TABLE "payroll_run_lines" ADD COLUMN     "total_calendar_days" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "employee_shift_overrides" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "override_start_time" TIME(0),
    "override_end_time" TIME(0),
    "reason" VARCHAR(255),
    "created_by" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_shift_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_shift_overrides_employee_id_date_idx" ON "employee_shift_overrides"("employee_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "employee_shift_overrides_employee_id_date_key" ON "employee_shift_overrides"("employee_id", "date");

-- AddForeignKey
ALTER TABLE "employee_shift_overrides" ADD CONSTRAINT "employee_shift_overrides_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_shift_overrides" ADD CONSTRAINT "employee_shift_overrides_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
