-- Drop the existing partial unique constraint so it can be rebuilt with a wider exclusion.
ALTER TABLE "student_fees" DROP CONSTRAINT IF EXISTS "student_fees_unique_regular_head";
DROP INDEX IF EXISTS "student_fees_unique_regular_head";

-- Clean up any stale duplicate rows left by previously broken split attempts.
-- For each group of non-split, non-discount rows sharing (student_id, fee_type_id, fee_date),
-- keep only the highest-id row (most recently created) and delete the earlier duplicates.
-- Heads, allocations, and surcharges referencing the deleted rows are handled below.
DELETE FROM "voucher_heads"
WHERE "student_fee_id" IN (
    SELECT id FROM "student_fees"
    WHERE "is_discount" = false
      AND "fee_date" IS NOT NULL
      AND (
        "description_prefix" IS NULL
        OR (
          "description_prefix" NOT LIKE 'PARTIAL PAYMENT OF%'
          AND "description_prefix" NOT LIKE 'BALANCE PAYMENT OF%'
        )
      )
      AND id NOT IN (
        SELECT MAX(id)
        FROM "student_fees"
        WHERE "is_discount" = false
          AND "fee_date" IS NOT NULL
          AND (
            "description_prefix" IS NULL
            OR (
              "description_prefix" NOT LIKE 'PARTIAL PAYMENT OF%'
              AND "description_prefix" NOT LIKE 'BALANCE PAYMENT OF%'
            )
          )
        GROUP BY "student_id", "fee_type_id", "fee_date"
      )
);

UPDATE "deposit_allocations"
SET "student_fee_id" = NULL
WHERE "student_fee_id" IN (
    SELECT id FROM "student_fees"
    WHERE "is_discount" = false
      AND "fee_date" IS NOT NULL
      AND (
        "description_prefix" IS NULL
        OR (
          "description_prefix" NOT LIKE 'PARTIAL PAYMENT OF%'
          AND "description_prefix" NOT LIKE 'BALANCE PAYMENT OF%'
        )
      )
      AND id NOT IN (
        SELECT MAX(id)
        FROM "student_fees"
        WHERE "is_discount" = false
          AND "fee_date" IS NOT NULL
          AND (
            "description_prefix" IS NULL
            OR (
              "description_prefix" NOT LIKE 'PARTIAL PAYMENT OF%'
              AND "description_prefix" NOT LIKE 'BALANCE PAYMENT OF%'
            )
          )
        GROUP BY "student_id", "fee_type_id", "fee_date"
      )
);

DELETE FROM "student_fees"
WHERE "is_discount" = false
  AND "fee_date" IS NOT NULL
  AND (
    "description_prefix" IS NULL
    OR (
      "description_prefix" NOT LIKE 'PARTIAL PAYMENT OF%'
      AND "description_prefix" NOT LIKE 'BALANCE PAYMENT OF%'
    )
  )
  AND id NOT IN (
    SELECT MAX(id)
    FROM "student_fees"
    WHERE "is_discount" = false
      AND "fee_date" IS NOT NULL
      AND (
        "description_prefix" IS NULL
        OR (
          "description_prefix" NOT LIKE 'PARTIAL PAYMENT OF%'
          AND "description_prefix" NOT LIKE 'BALANCE PAYMENT OF%'
        )
      )
    GROUP BY "student_id", "fee_type_id", "fee_date"
  );

-- Recreate as a partial unique index that excludes split rows.
-- PARTIAL PAYMENT OF and BALANCE PAYMENT OF rows are allowed to share the same
-- (student_id, fee_type_id, fee_date) tuple because they represent two halves of
-- one original fee head, not duplicate charges.
CREATE UNIQUE INDEX "student_fees_unique_regular_head"
    ON "student_fees" ("student_id", "fee_type_id", "fee_date")
    WHERE "is_discount" = false
      AND (
        description_prefix IS NULL
        OR (
          description_prefix NOT LIKE 'PARTIAL PAYMENT OF%'
          AND description_prefix NOT LIKE 'BALANCE PAYMENT OF%'
        )
      );
