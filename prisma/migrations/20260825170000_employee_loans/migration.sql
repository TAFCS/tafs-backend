-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'FORECLOSED', 'WRITTEN_OFF', 'OUTSTANDING');

-- CreateEnum
CREATE TYPE "LoanTransactionType" AS ENUM ('OPENING_BALANCE', 'DEDUCTION', 'LUMP_SUM_REPAYMENT', 'WRITE_OFF');

-- AlterTable
ALTER TABLE "payroll_run_lines" ADD COLUMN "loan_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "employee_loans" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "amount_repaid_opening" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "installment_count" INTEGER NOT NULL,
    "installment_amount" DECIMAL(12,2) NOT NULL,
    "disbursement_date" DATE NOT NULL,
    "start_period_start" DATE NOT NULL,
    "recovered_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lump_sum_repaid_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "written_off_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "carried_forward_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" VARCHAR(500),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "employee_loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_loan_transactions" (
    "id" SERIAL NOT NULL,
    "loan_id" INTEGER NOT NULL,
    "type" "LoanTransactionType" NOT NULL,
    "payroll_run_line_id" INTEGER,
    "due_amount" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balance_after" DECIMAL(12,2) NOT NULL,
    "reason" VARCHAR(500),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_loan_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_loans_employee_id_status_idx" ON "employee_loans"("employee_id", "status");

-- One active (still collecting) loan per employee
CREATE UNIQUE INDEX "employee_loans_one_active_key" ON "employee_loans"("employee_id") WHERE status = 'ACTIVE';

-- CreateIndex
CREATE INDEX "employee_loan_transactions_loan_id_created_at_idx" ON "employee_loan_transactions"("loan_id", "created_at");

-- CreateIndex
CREATE INDEX "employee_loan_transactions_payroll_run_line_id_idx" ON "employee_loan_transactions"("payroll_run_line_id");

-- One payroll-cycle deduction per loan/line (opening balance, lump sums, write-offs have null line id)
CREATE UNIQUE INDEX "employee_loan_txns_deduction_line_key" ON "employee_loan_transactions"("loan_id", "payroll_run_line_id") WHERE "payroll_run_line_id" IS NOT NULL AND "type" = 'DEDUCTION';

-- AddForeignKey
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loan_transactions" ADD CONSTRAINT "employee_loan_transactions_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "employee_loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loan_transactions" ADD CONSTRAINT "employee_loan_transactions_payroll_run_line_id_fkey" FOREIGN KEY ("payroll_run_line_id") REFERENCES "payroll_run_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
