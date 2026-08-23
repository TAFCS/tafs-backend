-- CreateEnum
CREATE TYPE "FinancialReportType" AS ENUM ('FEE_HEADS', 'DEPOSITS');

-- CreateEnum
CREATE TYPE "FinancialReportSnapshotStatus" AS ENUM ('DRAFT', 'FINALIZED');

-- CreateTable
CREATE TABLE "financial_report_snapshots" (
    "id" SERIAL NOT NULL,
    "report_type" "FinancialReportType" NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "view" VARCHAR(32) NOT NULL,
    "filters" JSONB NOT NULL,
    "filters_hash" VARCHAR(64) NOT NULL,
    "status" "FinancialReportSnapshotStatus" NOT NULL DEFAULT 'DRAFT',
    "totals" JSONB NOT NULL,
    "reconciles" BOOLEAN NOT NULL DEFAULT true,
    "generated_by" VARCHAR(100),
    "generated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_by" VARCHAR(100),
    "finalized_at" TIMESTAMP(6),
    "notes" VARCHAR(500),

    CONSTRAINT "financial_report_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "financial_report_snapshots_report_type_from_date_to_date_idx" ON "financial_report_snapshots"("report_type", "from_date", "to_date");

-- CreateIndex
CREATE INDEX "financial_report_snapshots_status_idx" ON "financial_report_snapshots"("status");

-- CreateIndex
CREATE INDEX "financial_report_snapshots_filters_hash_idx" ON "financial_report_snapshots"("filters_hash");

-- One finalized snapshot per report scope (filters + view + date range)
CREATE UNIQUE INDEX "financial_report_snapshots_finalized_scope_key"
ON "financial_report_snapshots"("report_type", "from_date", "to_date", "view", "filters_hash")
WHERE "status" = 'FINALIZED';
