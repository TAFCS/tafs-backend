-- ============================================================
-- Migration: Snapshot Billing — Remove amount from student_fees
-- Date: 2026-03-15
--
-- Rationale:
--   The `amount` column on `student_fees` was a mutable master price.
--   Under the "Snapshot Billing" design, the final billed price must be
--   immutable once a voucher is issued.  Moving the value into
--   `voucher_heads.net_amount` (the joint billing table) achieves:
--
--     1. Historical Accuracy  — already-issued bills are unaffected when
--        the school updates the class fee schedule mid-year.
--     2. Discount Context     — voucher_heads becomes the single source of
--        truth for the post-concession price for every billing cycle.
-- ============================================================

-- Step 1: Data Migration
--   Copy the current amount from every student_fees row into the
--   net_amount of each voucher_heads row that references it.
--   This preserves price history for any vouchers already issued.
UPDATE public.voucher_heads vh
SET net_amount = sf.amount
FROM public.student_fees sf
WHERE vh.student_fee_id = sf.id;

-- Step 2: Enforce the NOT NULL constraint on voucher_heads.net_amount
--   (guards against orphaned heads that have no price after step 1).
ALTER TABLE public.voucher_heads
    ALTER COLUMN net_amount SET NOT NULL;

-- Step 3: Remove the amount column from student_fees
--   WARNING: Only run this after confirming step 1 succeeded and
--   all voucher_heads rows have a valid net_amount.
ALTER TABLE public.student_fees
    DROP COLUMN IF EXISTS amount;
