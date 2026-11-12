-- TAFSD-504: Family Credit tile. Manual entries (add, deduct, refund, transfer,
-- undo) go into the same append-only ledger. Additive only: four nullable
-- columns, nothing existing changes.
ALTER TABLE "family_credit_ledger"
    ADD COLUMN "reverses_entry_id" INTEGER,
    ADD COLUMN "linked_entry_id" INTEGER,
    ADD COLUMN "counterpart_family_id" INTEGER,
    ADD COLUMN "method" VARCHAR(30);

-- An entry can only be undone once, even if two staff click Undo together.
CREATE UNIQUE INDEX "uq_family_credit_ledger_reverses" ON "family_credit_ledger"("reverses_entry_id");

CREATE INDEX "idx_family_credit_ledger_linked" ON "family_credit_ledger"("linked_entry_id");
