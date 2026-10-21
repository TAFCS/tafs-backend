-- TAFSD-398: deposit_allocations is looked up by voucher, fee and surcharge
-- on every payment / voucher path, but only deposit_id and type were indexed.
CREATE INDEX IF NOT EXISTS "idx_deposit_allocations_voucher" ON "deposit_allocations"("voucher_id");
CREATE INDEX IF NOT EXISTS "idx_deposit_allocations_student_fee" ON "deposit_allocations"("student_fee_id");
CREATE INDEX IF NOT EXISTS "idx_deposit_allocations_surcharge" ON "deposit_allocations"("surcharge_id");
