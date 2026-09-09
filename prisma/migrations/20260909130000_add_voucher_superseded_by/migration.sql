-- Supersession reactivation fix. When VouchersService.create() supersedes older
-- vouchers by fee-date (blunt rule: void every not-fully-paid voucher with
-- fee_date <= the new one), it now stamps each voided voucher with the id of the
-- voucher that superseded it. _destroyVoucherInTx STEP 1 uses this exact link to
-- decide what to reactivate when the superseding voucher is deleted — the old
-- head-set-containment heuristic silently failed to reactivate a predecessor
-- that carried a discount head or any already-paid head (those are never
-- absorbed onto the new voucher, so containment never held).

ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "superseded_by_voucher_id" INTEGER;

CREATE INDEX IF NOT EXISTS "idx_vouchers_superseded_by"
  ON "vouchers" ("superseded_by_voucher_id");
