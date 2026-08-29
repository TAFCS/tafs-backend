-- The Defaulters report scans, per student, every unpaid fee head before an
-- as-of date, then groups it by (academic_year, target_month) -- the same
-- candidate set VouchersService.computeArrears walks. It also reaches late
-- payment surcharges through vouchers.student_id, always filtered on
-- status <> 'VOID'. None of those access paths had an index.
--
-- Deliberately NOT partial indexes (e.g. WHERE status <> 'PAID'): Prisma cannot
-- express a partial index in schema.prisma, so the next `prisma migrate dev`
-- would diff one as drift and emit a DROP. Every index below has a matching
-- @@index line in schema.prisma, same as 20260817120000_add_financial_report_indexes.

CREATE INDEX IF NOT EXISTS idx_student_fees_student_status_fee_date    ON public.student_fees (student_id, status, fee_date);
CREATE INDEX IF NOT EXISTS idx_student_fees_student_year_month         ON public.student_fees (student_id, academic_year, target_month);
CREATE INDEX IF NOT EXISTS idx_vouchers_student_status                 ON public.vouchers (student_id, status);
CREATE INDEX IF NOT EXISTS idx_voucher_arrear_surcharges_voucher_waived ON public.voucher_arrear_surcharges (voucher_id, waived);
