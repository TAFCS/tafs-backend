-- Date-range financial reports scan fee_date / deposit_date / allocations
-- without existing indexes; add them before those endpoints ship.

CREATE INDEX IF NOT EXISTS idx_student_fees_fee_date       ON public.student_fees (fee_date);
CREATE INDEX IF NOT EXISTS idx_deposits_deposit_date       ON public.deposits (deposit_date);
CREATE INDEX IF NOT EXISTS idx_deposits_student_id         ON public.deposits (student_id);
CREATE INDEX IF NOT EXISTS idx_deposit_allocations_deposit ON public.deposit_allocations (deposit_id);
CREATE INDEX IF NOT EXISTS idx_deposit_allocations_type    ON public.deposit_allocations (type);
