-- Fee waiver: a head (or a whole voucher's heads) can be marked WAIVED — a
-- permanent write-off. A waived head is never expected to be paid, never accrues
-- arrears/surcharge in computeArrears, and cannot receive a deposit. A voucher
-- with any waived head becomes status = 'WAIVED' and its PDF gets a diagonal
-- "WAIVED" watermark. Reversible via un-waive. See VouchersService.waiveVoucher /
-- StudentFeesService.waiveHeads.

-- Postgres cannot add an enum value and use it in the same transaction, so this
-- runs on its own. Prisma migrate executes each statement separately.
ALTER TYPE "fee_status_enum" ADD VALUE IF NOT EXISTS 'WAIVED';

-- student_fees: the written-off difference plus who/when/why. waived_amount
-- equals amount (a head with any payment cannot be waived).
ALTER TABLE "student_fees" ADD COLUMN IF NOT EXISTS "waived_amount" DECIMAL(12,2);
ALTER TABLE "student_fees" ADD COLUMN IF NOT EXISTS "waived_at" TIMESTAMPTZ(6);
ALTER TABLE "student_fees" ADD COLUMN IF NOT EXISTS "waived_by" VARCHAR;
ALTER TABLE "student_fees" ADD COLUMN IF NOT EXISTS "waive_reason" VARCHAR(500);

-- voucher_heads: per-head write-off flag; balance is forced to 0 for a waived head.
ALTER TABLE "voucher_heads" ADD COLUMN IF NOT EXISTS "waived" BOOLEAN NOT NULL DEFAULT false;

-- vouchers: audit trail for a whole-voucher waiver (status is the free-form
-- VARCHAR that also carries the new 'WAIVED' value — no type change needed).
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "waived_at" TIMESTAMPTZ(6);
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "waived_by" VARCHAR(100);
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "waive_reason" VARCHAR(500);

-- NOTE: no partial index predicated on status = 'WAIVED' here — the new enum
-- value cannot be referenced in the same migration that adds it. The existing
-- idx_student_fees_student_status_fee_date already covers waived-head lookups.
