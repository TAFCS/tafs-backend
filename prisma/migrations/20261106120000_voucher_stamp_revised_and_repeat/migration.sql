-- TAFSD-419: the voucher itself knows it is revised, so every reprint keeps the stamp.
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "is_revised" BOOLEAN NOT NULL DEFAULT false;

-- TAFSD-420: frozen at issuance, adds the FINAL NOTICE line to a repeat PAY IMMEDIATELY voucher.
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "pay_immediately_repeat" BOOLEAN NOT NULL DEFAULT false;
