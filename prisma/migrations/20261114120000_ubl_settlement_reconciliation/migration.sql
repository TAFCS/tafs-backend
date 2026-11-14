-- UBL settlement reconciliation: a permanent log of every UBL bill payment, and
-- the settlement statements UBL sends, so the two can be matched line by line.

-- CreateTable
CREATE TABLE "ubl_transactions" (
    "id" SERIAL NOT NULL,
    "transaction_id" VARCHAR(100) NOT NULL,
    "consumer_number" VARCHAR(20),
    "student_id" INTEGER NOT NULL,
    "voucher_id" INTEGER,
    "voucher_number" VARCHAR(20),
    "channel" VARCHAR(20) NOT NULL,
    "payment_method" VARCHAR(20) NOT NULL,
    "amount_received" DECIMAL(12,2) NOT NULL,
    "amount_booked" DECIMAL(12,2) NOT NULL,
    "channel_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "transaction_at" TIMESTAMPTZ(6) NOT NULL,
    "branch_code" VARCHAR(20),
    "payer_bank_code" VARCHAR(20),
    "payer_bank_name" VARCHAR(100),
    "instrument_number" VARCHAR(30),
    "deposit_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ubl_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ubl_settlement_imports" (
    "id" SERIAL NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "sheet_name" VARCHAR(100),
    "uploaded_by" VARCHAR(100) NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "column_mapping" JSONB NOT NULL,
    "row_count" INTEGER NOT NULL,
    "skipped_rows" INTEGER NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "first_date" DATE,
    "last_date" DATE,

    CONSTRAINT "ubl_settlement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ubl_settlement_lines" (
    "id" SERIAL NOT NULL,
    "import_id" INTEGER NOT NULL,
    "row_number" INTEGER NOT NULL,
    "transaction_id" VARCHAR(100) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "transaction_date" DATE,
    "settlement_date" DATE,
    "channel" VARCHAR(50),
    "consumer_number" VARCHAR(30),
    "raw" JSONB NOT NULL,

    CONSTRAINT "ubl_settlement_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ubl_transactions_transaction_id_key" ON "ubl_transactions"("transaction_id");
CREATE INDEX "ubl_transactions_transaction_at_idx" ON "ubl_transactions"("transaction_at");
CREATE INDEX "ubl_transactions_student_id_idx" ON "ubl_transactions"("student_id");
CREATE INDEX "ubl_settlement_lines_transaction_id_idx" ON "ubl_settlement_lines"("transaction_id");
CREATE INDEX "ubl_settlement_lines_import_id_idx" ON "ubl_settlement_lines"("import_id");
CREATE INDEX "ubl_settlement_lines_transaction_date_idx" ON "ubl_settlement_lines"("transaction_date");
CREATE INDEX "ubl_settlement_lines_settlement_date_idx" ON "ubl_settlement_lines"("settlement_date");

ALTER TABLE "ubl_settlement_lines" ADD CONSTRAINT "ubl_settlement_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "ubl_settlement_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill any UBL payment posted before this log existed, from the deposit
-- UblService wrote: reference_number is UBL's transaction id, and remarks read
-- "UBL <CHANNEL> · <METHOD> · [instrument X ·] [branch Y ·] [1Bill fee PKR N (not booked)]".
-- deposit_date was written from UBL's transaction time, stored as UTC.
INSERT INTO "ubl_transactions" (
    "transaction_id", "consumer_number", "student_id", "voucher_id", "voucher_number",
    "channel", "payment_method", "amount_received", "amount_booked", "channel_fee",
    "transaction_at", "branch_code", "payer_bank_code", "payer_bank_name",
    "instrument_number", "deposit_id", "created_at"
)
SELECT
    d.reference_number,
    NULL,
    d.student_id,
    v.id,
    v.voucher_number,
    COALESCE(substring(d.remarks FROM '^UBL ([A-Z_]+)'), 'UNKNOWN'),
    COALESCE(NULLIF(split_part(d.remarks, ' · ', 2), ''), 'UNKNOWN'),
    d.total_amount + COALESCE(substring(d.remarks FROM '1Bill fee PKR ([0-9]+)')::numeric, 0),
    d.total_amount,
    COALESCE(substring(d.remarks FROM '1Bill fee PKR ([0-9]+)')::numeric, 0),
    d.deposit_date AT TIME ZONE 'UTC',
    substring(d.remarks FROM 'branch ([^ ]+)'),
    d.bank_code,
    d.bank_name,
    substring(d.remarks FROM 'instrument ([^ ]+)'),
    d.id,
    d.created_at AT TIME ZONE 'UTC'
FROM "deposits" d
LEFT JOIN LATERAL (
    SELECT vo.id, vo.voucher_number
    FROM "deposit_allocations" da
    JOIN "vouchers" vo ON vo.id = da.voucher_id
    WHERE da.deposit_id = d.id
    ORDER BY da.id
    LIMIT 1
) v ON TRUE
WHERE d.payment_method = 'ubl' AND d.reference_number IS NOT NULL
ON CONFLICT ("transaction_id") DO NOTHING;
