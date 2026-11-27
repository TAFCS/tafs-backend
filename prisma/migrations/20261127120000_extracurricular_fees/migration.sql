-- TAFSD-605: extracurricular (EC) fee vouchers, a billing flow kept apart from
-- academic fees. Additive only: 3 enums and 7 new tables. No existing table or
-- column changes, no academic query reads these tables, and EC code tolerates
-- nothing here being missing beyond its own endpoints failing, so applying this
-- before or after the code is deployed is safe. Rules live in
-- src/modules/extracurricular/CLAUDE.md.
--
-- No CHECK constraint, partial index or trigger: nothing to copy into
-- test/db/db-only-objects.sql. Money rules are enforced in the service layer
-- (voucher row lock + recompute-from-allocations), one-voucher-per-charge by a
-- compare-and-set on ec_student_charges.current_voucher_id.
--
-- Links to students are ON DELETE CASCADE so a permanent student delete keeps
-- working; links between EC tables are NO ACTION (checked at statement end, so a
-- cascading student delete still clears them in one go). ec_vouchers has no FK
-- to bank_accounts on purpose (bank_account_id + bank_snapshot).

-- CreateEnum
CREATE TYPE "ec_fee_frequency" AS ENUM ('MONTHLY', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "ec_charge_status" AS ENUM ('NOT_ISSUED', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'WAIVED');

-- CreateEnum
CREATE TYPE "ec_voucher_status" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'WAIVED');

-- CreateTable
CREATE TABLE "ec_fee_heads" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "frequency" "ec_fee_frequency" NOT NULL,
    "months" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" VARCHAR(100),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ec_fee_heads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ec_class_fee_schedule" (
    "id" SERIAL NOT NULL,
    "class_id" INTEGER NOT NULL,
    "fee_head_id" INTEGER NOT NULL,
    "campus_id" INTEGER,
    "academic_year" VARCHAR(10) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "updated_by" VARCHAR(100),
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ec_class_fee_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ec_student_charges" (
    "id" SERIAL NOT NULL,
    "student_id" INTEGER NOT NULL,
    "fee_head_id" INTEGER NOT NULL,
    "academic_year" VARCHAR(10) NOT NULL,
    "target_month" INTEGER NOT NULL,
    "period" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "amount_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "waived_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "ec_charge_status" NOT NULL DEFAULT 'NOT_ISSUED',
    "current_voucher_id" INTEGER,
    "source" VARCHAR(20) NOT NULL DEFAULT 'CUSTOM',
    "remarks" VARCHAR(255),
    "created_by" VARCHAR(100),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ec_student_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ec_vouchers" (
    "id" SERIAL NOT NULL,
    "voucher_number" VARCHAR(16),
    "student_id" INTEGER NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "section_id" INTEGER,
    "academic_year" VARCHAR(10) NOT NULL,
    "issue_date" DATE NOT NULL,
    "expiry_date" DATE NOT NULL,
    "status" "ec_voucher_status" NOT NULL DEFAULT 'UNPAID',
    "total_amount" DECIMAL(12,2) NOT NULL,
    "amount_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount_waived" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bank_account_id" INTEGER,
    "bank_snapshot" JSONB NOT NULL,
    "reissued_from_voucher_id" INTEGER,
    "waived_at" TIMESTAMPTZ(6),
    "waived_by" VARCHAR(100),
    "waive_reason" VARCHAR(500),
    "pdf_url" TEXT,
    "pdf_hash" VARCHAR(64),
    "paid_pdf_url" TEXT,
    "paid_pdf_filename" VARCHAR(255),
    "paid_pdf_generated_at" TIMESTAMP(6),
    "generated_by_name" VARCHAR(100),
    "created_by" VARCHAR(100),
    "bulk_run_id" VARCHAR(36),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ec_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ec_voucher_lines" (
    "id" SERIAL NOT NULL,
    "voucher_id" INTEGER NOT NULL,
    "charge_id" INTEGER NOT NULL,
    "description" VARCHAR(150) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "amount_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "waived_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ec_voucher_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ec_deposits" (
    "id" SERIAL NOT NULL,
    "voucher_id" INTEGER NOT NULL,
    "student_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "deposit_date" DATE NOT NULL,
    "payment_method" VARCHAR(30) NOT NULL,
    "reference_number" VARCHAR(100),
    "bank_name" VARCHAR(100),
    "remarks" VARCHAR(500),
    "recorded_by" VARCHAR(100),
    "recorded_by_name" VARCHAR(100),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ec_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ec_deposit_allocations" (
    "id" SERIAL NOT NULL,
    "deposit_id" INTEGER NOT NULL,
    "line_id" INTEGER NOT NULL,
    "charge_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "ec_deposit_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ec_fee_heads_name_key" ON "ec_fee_heads"("name");

-- CreateIndex
CREATE INDEX "ec_class_fee_schedule_academic_year_idx" ON "ec_class_fee_schedule"("academic_year");

-- CreateIndex
CREATE UNIQUE INDEX "ec_class_fee_schedule_class_id_fee_head_id_campus_id_academ_key" ON "ec_class_fee_schedule"("class_id", "fee_head_id", "campus_id", "academic_year");

-- CreateIndex
CREATE INDEX "ec_student_charges_current_voucher_id_idx" ON "ec_student_charges"("current_voucher_id");

-- CreateIndex
CREATE INDEX "ec_student_charges_student_id_status_idx" ON "ec_student_charges"("student_id", "status");

-- CreateIndex
CREATE INDEX "ec_student_charges_fee_head_id_period_idx" ON "ec_student_charges"("fee_head_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "ec_student_charges_student_id_fee_head_id_academic_year_tar_key" ON "ec_student_charges"("student_id", "fee_head_id", "academic_year", "target_month");

-- CreateIndex
CREATE UNIQUE INDEX "ec_vouchers_voucher_number_key" ON "ec_vouchers"("voucher_number");

-- CreateIndex
CREATE UNIQUE INDEX "ec_vouchers_reissued_from_voucher_id_key" ON "ec_vouchers"("reissued_from_voucher_id");

-- CreateIndex
CREATE INDEX "ec_vouchers_student_id_status_idx" ON "ec_vouchers"("student_id", "status");

-- CreateIndex
CREATE INDEX "ec_vouchers_expiry_date_idx" ON "ec_vouchers"("expiry_date");

-- CreateIndex
CREATE INDEX "ec_vouchers_issue_date_idx" ON "ec_vouchers"("issue_date");

-- CreateIndex
CREATE INDEX "ec_vouchers_campus_id_class_id_idx" ON "ec_vouchers"("campus_id", "class_id");

-- CreateIndex
CREATE INDEX "ec_vouchers_bulk_run_id_idx" ON "ec_vouchers"("bulk_run_id");

-- CreateIndex
CREATE INDEX "ec_voucher_lines_charge_id_idx" ON "ec_voucher_lines"("charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "ec_voucher_lines_voucher_id_charge_id_key" ON "ec_voucher_lines"("voucher_id", "charge_id");

-- CreateIndex
CREATE INDEX "ec_deposits_voucher_id_idx" ON "ec_deposits"("voucher_id");

-- CreateIndex
CREATE INDEX "ec_deposits_student_id_idx" ON "ec_deposits"("student_id");

-- CreateIndex
CREATE INDEX "ec_deposits_deposit_date_idx" ON "ec_deposits"("deposit_date");

-- CreateIndex
CREATE INDEX "ec_deposit_allocations_line_id_idx" ON "ec_deposit_allocations"("line_id");

-- CreateIndex
CREATE INDEX "ec_deposit_allocations_charge_id_idx" ON "ec_deposit_allocations"("charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "ec_deposit_allocations_deposit_id_line_id_key" ON "ec_deposit_allocations"("deposit_id", "line_id");

-- AddForeignKey
ALTER TABLE "ec_class_fee_schedule" ADD CONSTRAINT "ec_class_fee_schedule_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_class_fee_schedule" ADD CONSTRAINT "ec_class_fee_schedule_fee_head_id_fkey" FOREIGN KEY ("fee_head_id") REFERENCES "ec_fee_heads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_class_fee_schedule" ADD CONSTRAINT "ec_class_fee_schedule_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_student_charges" ADD CONSTRAINT "ec_student_charges_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_student_charges" ADD CONSTRAINT "ec_student_charges_fee_head_id_fkey" FOREIGN KEY ("fee_head_id") REFERENCES "ec_fee_heads"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_student_charges" ADD CONSTRAINT "ec_student_charges_current_voucher_id_fkey" FOREIGN KEY ("current_voucher_id") REFERENCES "ec_vouchers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_vouchers" ADD CONSTRAINT "ec_vouchers_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_vouchers" ADD CONSTRAINT "ec_vouchers_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_vouchers" ADD CONSTRAINT "ec_vouchers_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_vouchers" ADD CONSTRAINT "ec_vouchers_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_vouchers" ADD CONSTRAINT "ec_vouchers_reissued_from_voucher_id_fkey" FOREIGN KEY ("reissued_from_voucher_id") REFERENCES "ec_vouchers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_voucher_lines" ADD CONSTRAINT "ec_voucher_lines_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "ec_vouchers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_voucher_lines" ADD CONSTRAINT "ec_voucher_lines_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "ec_student_charges"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_deposits" ADD CONSTRAINT "ec_deposits_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "ec_vouchers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_deposits" ADD CONSTRAINT "ec_deposits_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_deposit_allocations" ADD CONSTRAINT "ec_deposit_allocations_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "ec_deposits"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_deposit_allocations" ADD CONSTRAINT "ec_deposit_allocations_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "ec_voucher_lines"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ec_deposit_allocations" ADD CONSTRAINT "ec_deposit_allocations_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "ec_student_charges"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
