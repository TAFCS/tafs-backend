-- ============================================================
-- Migration: Restore student_fees.amount from voucher_heads
-- Date: 2026-05-12
--
-- Rationale:
--   The `amount` column on `student_fees` was accidentally dropped
--   and re-added as a nullable column, wiping all values.
--
--   Recovery sources (in priority order):
--     1. Non-discount fees: voucher_heads.net_amount (the March-15
--        snapshot migration copied sf.amount → vh.net_amount directly,
--        so MAX(net_amount) where net_amount > 0 is the original amount).
--     2. Discount fees:   ABS(MIN(voucher_heads.net_amount)) — discount
--        heads store a negative net_amount equal to -(discount amount).
--     3. Fallback:        student_fees.amount_before_discount — used for
--        fees that were never issued (no voucher_heads) and for any
--        rows still null after steps 1-2.
-- ============================================================

-- ── Step 0: Diagnostic (saved as a comment for the record) ─────────────────
-- Run manually before applying if you want to verify the scale:
--
--   SELECT
--     COUNT(*)                                           AS total_null,
--     COUNT(*) FILTER (WHERE is_discount = false)        AS non_discount_null,
--     COUNT(*) FILTER (WHERE is_discount = true)         AS discount_null,
--     COUNT(*) FILTER (WHERE amount_before_discount IS NOT NULL) AS has_fallback
--   FROM student_fees WHERE amount IS NULL;
-- ──────────────────────────────────────────────────────────────────────────


-- ── Step 1: Restore non-discount fees from voucher_heads.net_amount ────────
--   The 2026-03-15 snapshot migration set net_amount = sf.amount for every
--   existing voucher_head, so the highest positive net_amount for a fee is
--   the original fee amount.  (All heads for the same fee should be equal;
--   MAX guards against any edge-case drift.)
UPDATE public.student_fees sf
SET    amount = vh.best_amount
FROM (
    SELECT   student_fee_id,
             MAX(net_amount) AS best_amount
    FROM     public.voucher_heads
    WHERE    net_amount > 0
    GROUP BY student_fee_id
) vh
WHERE  sf.id          = vh.student_fee_id
  AND  sf.amount      IS NULL
  AND  sf.is_discount = false;


-- ── Step 2: Restore discount fees from voucher_heads.net_amount ────────────
--   Discount voucher_heads store net_amount as a negative value equal to
--   -(discount amount).  ABS(MIN(...)) recovers the original amount.
UPDATE public.student_fees sf
SET    amount = ABS(vh.best_amount)
FROM (
    SELECT   student_fee_id,
             MIN(net_amount) AS best_amount
    FROM     public.voucher_heads
    WHERE    net_amount < 0
    GROUP BY student_fee_id
) vh
WHERE  sf.id          = vh.student_fee_id
  AND  sf.amount      IS NULL
  AND  sf.is_discount = true;


-- ── Step 3: Fallback — use amount_before_discount for remaining nulls ──────
--   Covers fees that were never issued (no voucher_heads), fees whose
--   only voucher_heads had net_amount = 0 (created when amount was already
--   null), and any discount rows still without a head.
UPDATE public.student_fees sf
SET    amount = sf.amount_before_discount
WHERE  sf.amount               IS NULL
  AND  sf.amount_before_discount IS NOT NULL;


-- ── Step 4: Final verification query ──────────────────────────────────────
--   After running, execute this to confirm recovery completeness:
--
--   SELECT
--     COUNT(*)                                    AS still_null,
--     COUNT(*) FILTER (WHERE is_discount = false) AS non_discount_still_null,
--     COUNT(*) FILTER (WHERE is_discount = true)  AS discount_still_null
--   FROM student_fees WHERE amount IS NULL;
--
--   Rows still null after Step 3 are fees where BOTH amount and
--   amount_before_discount were null — these need manual review.
-- ──────────────────────────────────────────────────────────────────────────
