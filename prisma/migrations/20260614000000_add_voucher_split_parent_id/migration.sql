-- Add split_parent_id to vouchers: marks a voucher as a product of splitPartiallyPaid.
-- When set, it holds the id of the original (pre-split) voucher. NULL = not a split artifact.
-- Used to keep the destructive delete/merge reversal flow for split vouchers while letting
-- non-split fully-paid vouchers revert to UNPAID on deposit reversal.
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "split_parent_id" INTEGER;
