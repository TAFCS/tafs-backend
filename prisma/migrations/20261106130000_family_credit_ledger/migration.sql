-- TAFSD-421: family credit. Append-only ledger; the balance is the sum of the rows.
CREATE TABLE IF NOT EXISTS "family_credit_ledger" (
    "id" SERIAL NOT NULL,
    "family_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "student_id" INTEGER,
    "voucher_id" INTEGER,
    "deposit_id" INTEGER,
    "notes" TEXT,
    "created_by" VARCHAR(100),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_credit_ledger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_family_credit_ledger_family" ON "family_credit_ledger"("family_id", "id");
CREATE INDEX IF NOT EXISTS "idx_family_credit_ledger_deposit" ON "family_credit_ledger"("deposit_id");
CREATE INDEX IF NOT EXISTS "idx_family_credit_ledger_student" ON "family_credit_ledger"("student_id");

-- Safe to re-run: production already has this table and key (see TAFSD-421).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_credit_ledger_family_id_fkey') THEN
        ALTER TABLE "family_credit_ledger"
            ADD CONSTRAINT "family_credit_ledger_family_id_fkey"
            FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;
END $$;

-- Part of a deposit's cash that became family credit, and whether a deposit was
-- paid from credit (no new cash). Every existing deposit keeps the defaults.
ALTER TABLE "deposits" ADD COLUMN IF NOT EXISTS "excess_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "deposits" ADD COLUMN IF NOT EXISTS "from_credit" BOOLEAN NOT NULL DEFAULT false;
