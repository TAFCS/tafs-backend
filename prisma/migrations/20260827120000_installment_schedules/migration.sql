-- Remaining custom monthly amounts for security deposits and employee loans.
ALTER TABLE "employee_security_deposits" ADD COLUMN "installment_schedule" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "employee_loans" ADD COLUMN "installment_schedule" JSONB NOT NULL DEFAULT '[]';

CREATE OR REPLACE FUNCTION _build_remaining_installment_schedule(remaining NUMERIC, installment NUMERIC)
RETURNS JSONB AS $$
DECLARE
  rem NUMERIC := ROUND(COALESCE(remaining, 0), 2);
  step NUMERIC := ROUND(COALESCE(installment, 0), 2);
  arr JSONB := '[]'::jsonb;
  take NUMERIC;
  guard INT := 0;
BEGIN
  IF rem <= 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF step <= 0 THEN
    RETURN jsonb_build_array(rem);
  END IF;
  WHILE rem > 0 AND guard < 120 LOOP
    take := LEAST(step, rem);
    arr := arr || jsonb_build_array(take);
    rem := ROUND(rem - take, 2);
    guard := guard + 1;
  END LOOP;
  RETURN arr;
END;
$$ LANGUAGE plpgsql;

UPDATE "employee_security_deposits"
SET "installment_schedule" = _build_remaining_installment_schedule(
  GREATEST("total_amount" - "recovered_amount", 0),
  "installment_amount"
);

UPDATE "employee_loans"
SET "installment_schedule" = _build_remaining_installment_schedule(
  GREATEST(
    "total_amount" - "amount_repaid_opening" - "recovered_amount" - "lump_sum_repaid_amount" - "written_off_amount",
    0
  ),
  "installment_amount"
);

DROP FUNCTION _build_remaining_installment_schedule(NUMERIC, NUMERIC);
