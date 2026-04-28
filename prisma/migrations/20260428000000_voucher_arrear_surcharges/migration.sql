-- Migration: voucher_arrear_surcharges
-- Surcharges are moved out of student_fees into a voucher-scoped table.
-- When a voucher is deleted the surcharges cascade-delete automatically.

BEGIN;

-- 1. Create the new surcharge table
CREATE TABLE IF NOT EXISTS "voucher_arrear_surcharges" (
    "id"              SERIAL          PRIMARY KEY,
    "voucher_id"      INTEGER         NOT NULL,
    "arrear_fee_date" DATE            NOT NULL,
    "arrear_month"    INTEGER         NOT NULL,
    "arrear_year"     VARCHAR(10)     NOT NULL,
    "amount"          DECIMAL(12, 2)  NOT NULL,
    "waived"          BOOLEAN         NOT NULL DEFAULT false,
    "waived_by"       VARCHAR(255),
    CONSTRAINT "voucher_arrear_surcharges_voucher_id_fkey"
        FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "voucher_arrear_surcharges_voucher_id_idx"
    ON "voucher_arrear_surcharges"("voucher_id");

-- 2. Migrate existing student_fees surcharge rows into the new table.
--    Each surcharge row is linked to a voucher via voucher_heads.
--    The waived flag / waived_by come from the parent voucher.
INSERT INTO "voucher_arrear_surcharges"
    ("voucher_id", "arrear_fee_date", "arrear_month", "arrear_year", "amount", "waived", "waived_by")
SELECT
    vh."voucher_id",
    sf."fee_date",
    COALESCE(sf."target_month", sf."month", 0),
    COALESCE(sf."academic_year", ''),
    COALESCE(sf."amount", 1000),
    v."surcharge_waived",
    v."surcharge_waived_by"
FROM "student_fees" sf
JOIN "voucher_heads" vh ON vh."student_fee_id" = sf."id"
JOIN "vouchers"      v  ON v."id"              = vh."voucher_id"
WHERE sf."is_arrear_surcharge" = true;

-- 3. Remove deposit_allocations rows that reference surcharge voucher_heads
--    (surcharge heads have never been paid, but guard against edge cases).
DELETE FROM "deposit_allocations"
WHERE "student_fee_id" IN (
    SELECT id FROM "student_fees" WHERE "is_arrear_surcharge" = true
);

-- 4. Delete the voucher_heads rows pointing to surcharge student_fees
DELETE FROM "voucher_heads"
WHERE "student_fee_id" IN (
    SELECT id FROM "student_fees" WHERE "is_arrear_surcharge" = true
);

-- 5. Delete the surcharge student_fees rows
DELETE FROM "student_fees" WHERE "is_arrear_surcharge" = true;

-- 6. Drop the now-redundant total_arrear_surcharge column from vouchers
ALTER TABLE "vouchers" DROP COLUMN IF EXISTS "total_arrear_surcharge";

COMMIT;
