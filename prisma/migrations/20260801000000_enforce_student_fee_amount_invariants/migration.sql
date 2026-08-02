-- Enforce the two core invariants of student_fees at the database layer, so they
-- hold no matter which code path performs the write (bulk save, universal
-- scholarship setter, voucher split/merge, installment edits, ad-hoc SQL, ...).
--
--   1. `amount` is the SINGLE SOURCE OF TRUTH for receivables and is always a
--      whole number. Everything financial (voucher net_amount, totals, deposit
--      allocation, balances, outstanding) derives from it.
--
--   2. `amount_after_discount` is a DERIVED column describing the intermediate
--      "after discount, before scholarship" stage. When a head has no
--      scholarship, that stage IS the final amount by definition. Historically
--      many code paths updated `amount` without maintaining this column, and the
--      resulting drift was rendered as a phantom scholarship on vouchers (a plain
--      discount printed as "SCHOLARSHIP -1,000", and breakdown lines that did not
--      reconcile with PAYABLE BY DUE DATE). Forcing the invariant here makes that
--      class of bug structurally impossible rather than something every future
--      writer has to remember.
--
-- Heads that DO carry a scholarship keep their entered `amount_after_discount`
-- base untouched: it is the meaningful figure the percentage was applied to, and
-- reverse-deriving it from `amount` would lose precision (and divide by zero at 100%).

CREATE OR REPLACE FUNCTION enforce_student_fee_amount_invariants()
RETURNS trigger AS $$
BEGIN
    -- Invariant 1: receivable is always a whole number.
    IF NEW.amount IS NOT NULL THEN
        NEW.amount := ROUND(NEW.amount, 0);
    END IF;

    -- Invariant 2: no scholarship => "after discount" is the final amount.
    IF COALESCE(NEW.scholarship_percentage, 0) = 0 THEN
        NEW.amount_after_discount := NEW.amount;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_student_fees_amount_invariants ON "student_fees";
CREATE TRIGGER trg_student_fees_amount_invariants
    BEFORE INSERT OR UPDATE ON "student_fees"
    FOR EACH ROW
    EXECUTE FUNCTION enforce_student_fee_amount_invariants();

-- Backfill existing rows to satisfy the invariants.
-- Only scholarship-computed rows carry fractions today (e.g. 18,995 x 0.75 =
-- 14,246.25); none of them have any payment recorded against them.
UPDATE "student_fees"
SET amount = ROUND(amount, 0)
WHERE amount IS NOT NULL
  AND amount <> ROUND(amount, 0);

UPDATE "student_fees"
SET amount_after_discount = amount
WHERE COALESCE(scholarship_percentage, 0) = 0
  AND amount IS NOT NULL
  AND amount_after_discount IS DISTINCT FROM amount;
