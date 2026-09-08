ALTER TABLE "employee_profiles"
  ADD COLUMN "last_increment_at" DATE,
  ADD COLUMN "increment_cycle_months" INTEGER;

CREATE TABLE "salary_increment_settings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "default_cycle_months" INTEGER NOT NULL DEFAULT 12,
  "upcoming_window_days" INTEGER NOT NULL DEFAULT 60,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "updated_by" TEXT,
  CONSTRAINT "salary_increment_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "salary_increments" (
  "id" SERIAL NOT NULL,
  "employee_id" INTEGER NOT NULL,
  "mode" VARCHAR(20) NOT NULL,
  "percentage" DECIMAL(8,4),
  "fixed_amount" DECIMAL(12,2),
  "previous_pay" DECIMAL(12,2) NOT NULL,
  "new_pay" DECIMAL(12,2) NOT NULL,
  "cycle_months_used" INTEGER NOT NULL,
  "effective_from" DATE NOT NULL,
  "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_by" TEXT,
  "notes" TEXT,
  "bulk_batch_id" TEXT,
  CONSTRAINT "salary_increments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "salary_increments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "salary_increments_employee_id_effective_from_idx" ON "salary_increments"("employee_id", "effective_from");
CREATE INDEX "salary_increments_bulk_batch_id_idx" ON "salary_increments"("bulk_batch_id");
INSERT INTO "salary_increment_settings" ("id", "default_cycle_months", "upcoming_window_days", "updated_at") VALUES (1, 12, 60, CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING;
UPDATE "employee_profiles" ep SET "last_increment_at" = latest."valid_from"::date
FROM (SELECT DISTINCT ON ("employee_id") "employee_id", "valid_from" FROM "employee_progression_periods" WHERE "change_type" = 'PAY_CHANGED' ORDER BY "employee_id", "valid_from" DESC) latest
WHERE ep.id = latest."employee_id";
