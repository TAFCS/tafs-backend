-- PAY IMMEDIATELY: frozen at creation time when the student already had 2+
-- distinct arrear months outstanding when this voucher was issued. Drives the
-- forced issue_date+4 due/validity dates and the PDF's "PAY IMMEDIATELY"
-- watermark. See VouchersService.create() / splitPartiallyPaid() and
-- src/modules/vouchers/CLAUDE.md.
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "pay_immediately" BOOLEAN NOT NULL DEFAULT false;
