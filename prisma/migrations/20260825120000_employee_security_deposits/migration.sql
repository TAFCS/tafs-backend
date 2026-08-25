-- CreateEnum
CREATE TYPE "SecurityDepositStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'REFUNDED', 'FORFEITED', 'PARTIALLY_FORFEITED');

-- CreateEnum
CREATE TYPE "SecurityDepositTransactionType" AS ENUM ('DEDUCTION', 'REFUND', 'FORFEIT');

-- AlterTable
ALTER TABLE "payroll_run_lines" ADD COLUMN "security_deposit_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "employee_security_deposits" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "installment_count" INTEGER NOT NULL,
    "installment_amount" DECIMAL(12,2) NOT NULL,
    "start_period_start" DATE NOT NULL,
    "recovered_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refunded_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "forfeited_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "carried_forward_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "SecurityDepositStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" VARCHAR(500),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "employee_security_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_security_deposit_transactions" (
    "id" SERIAL NOT NULL,
    "deposit_id" INTEGER NOT NULL,
    "type" "SecurityDepositTransactionType" NOT NULL,
    "payroll_run_line_id" INTEGER,
    "due_amount" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "running_balance" DECIMAL(12,2) NOT NULL,
    "reason" VARCHAR(500),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_security_deposit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_security_deposits_employee_id_status_idx" ON "employee_security_deposits"("employee_id", "status");

-- One open (still collecting or still holding) plan per employee
CREATE UNIQUE INDEX "employee_security_deposits_one_open_key" ON "employee_security_deposits"("employee_id") WHERE status IN ('ACTIVE', 'COMPLETED');

-- CreateIndex
CREATE INDEX "employee_security_deposit_transactions_deposit_id_created_at_idx" ON "employee_security_deposit_transactions"("deposit_id", "created_at");

-- CreateIndex
CREATE INDEX "employee_security_deposit_transactions_payroll_run_line_id_idx" ON "employee_security_deposit_transactions"("payroll_run_line_id");

-- One payroll-cycle deduction per plan/line (refunds/forfeits have null line id)
CREATE UNIQUE INDEX "employee_security_deposit_txns_deduction_line_key" ON "employee_security_deposit_transactions"("deposit_id", "payroll_run_line_id") WHERE "payroll_run_line_id" IS NOT NULL AND "type" = 'DEDUCTION';

-- AddForeignKey
ALTER TABLE "employee_security_deposits" ADD CONSTRAINT "employee_security_deposits_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_security_deposit_transactions" ADD CONSTRAINT "employee_security_deposit_transactions_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "employee_security_deposits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_security_deposit_transactions" ADD CONSTRAINT "employee_security_deposit_transactions_payroll_run_line_id_fkey" FOREIGN KEY ("payroll_run_line_id") REFERENCES "payroll_run_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
