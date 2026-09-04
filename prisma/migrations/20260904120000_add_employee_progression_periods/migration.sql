-- CreateTable
CREATE TABLE "employee_progression_periods" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "campus_id" INTEGER,
    "segment_id" INTEGER,
    "department_id" INTEGER,
    "staff_category_id" INTEGER,
    "reporting_manager_id" INTEGER,
    "job_title" VARCHAR(100),
    "employment_type" VARCHAR(50),
    "employment_status" VARCHAR(30) NOT NULL,
    "monthly_pay" DECIMAL(12,2),
    "payroll_enabled" BOOLEAN NOT NULL DEFAULT true,
    "class_sections" JSONB,
    "change_type" VARCHAR(30) NOT NULL,
    "changed_by" VARCHAR(255),
    "notes" VARCHAR(255),
    "valid_from" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(6),

    CONSTRAINT "employee_progression_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_progression_periods_employee_id_valid_from_idx" ON "employee_progression_periods"("employee_id", "valid_from");

-- Enforce one open (current) period per employee
CREATE UNIQUE INDEX "employee_progression_periods_one_open_per_employee"
  ON "employee_progression_periods" ("employee_id")
  WHERE "valid_to" IS NULL;

-- AddForeignKey
ALTER TABLE "employee_progression_periods" ADD CONSTRAINT "employee_progression_periods_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_progression_periods" ADD CONSTRAINT "employee_progression_periods_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_progression_periods" ADD CONSTRAINT "employee_progression_periods_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_progression_periods" ADD CONSTRAINT "employee_progression_periods_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_progression_periods" ADD CONSTRAINT "employee_progression_periods_staff_category_id_fkey" FOREIGN KEY ("staff_category_id") REFERENCES "staff_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
