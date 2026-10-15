-- TAFSD-327: reporting hierarchy. One row per (employee, manager) line. A
-- super admin may set any lines they like; there are no structural rules.

-- CreateTable
CREATE TABLE "employee_reporting_lines" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "manager_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(255),

    CONSTRAINT "employee_reporting_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_reporting_lines_employee_id_manager_id_key" ON "employee_reporting_lines"("employee_id", "manager_id");

-- CreateIndex
CREATE INDEX "employee_reporting_lines_manager_id_idx" ON "employee_reporting_lines"("manager_id");

-- AddForeignKey
ALTER TABLE "employee_reporting_lines" ADD CONSTRAINT "employee_reporting_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_reporting_lines" ADD CONSTRAINT "employee_reporting_lines_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
