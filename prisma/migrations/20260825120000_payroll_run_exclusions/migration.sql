-- CreateTable
CREATE TABLE "payroll_run_exclusions" (
    "id" SERIAL NOT NULL,
    "payroll_run_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "reason" VARCHAR(300),
    "excluded_by" TEXT NOT NULL,
    "excluded_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_run_exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payroll_run_exclusions_payroll_run_id_employee_id_key" ON "payroll_run_exclusions"("payroll_run_id", "employee_id");

-- AddForeignKey
ALTER TABLE "payroll_run_exclusions" ADD CONSTRAINT "payroll_run_exclusions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_exclusions" ADD CONSTRAINT "payroll_run_exclusions_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_exclusions" ADD CONSTRAINT "payroll_run_exclusions_excluded_by_fkey" FOREIGN KEY ("excluded_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
