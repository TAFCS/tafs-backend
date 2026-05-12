-- ============================================================
-- Migration: Fill NULL amounts for June/July 2026 fee rows
--            from the matching May 2026 row (same student, fee_type 1)
-- Date: 2026-05-12
-- ============================================================

UPDATE public.student_fees sf
SET    amount = may_fee.amount
FROM (
    SELECT student_id, amount
    FROM   public.student_fees
    WHERE  fee_date    = '2026-05-01'
      AND  fee_type_id = 1
      AND  amount      IS NOT NULL
) may_fee
WHERE  sf.student_id  = may_fee.student_id
  AND  sf.fee_type_id = 1
  AND  sf.fee_date    IN ('2026-06-01', '2026-07-01')
  AND  sf.amount      IS NULL;
