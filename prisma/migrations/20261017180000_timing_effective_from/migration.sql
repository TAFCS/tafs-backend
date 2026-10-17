-- TAFSD-369: effective-from dates on timing changes.

-- When each progression change was saved, separate from when it takes effect
-- (valid_from). Until now they were the same instant.
ALTER TABLE "employee_progression_periods" ADD COLUMN "recorded_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "employee_progression_periods" SET "recorded_at" = "valid_from";

-- CreateTable
CREATE TABLE "employee_scheduled_timing_changes" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "timings" JSONB NOT NULL,
    "changed_by" VARCHAR(255),
    "recorded_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_scheduled_timing_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_scheduled_timing_changes_employee_id_effective_from_key" ON "employee_scheduled_timing_changes"("employee_id", "effective_from");
CREATE INDEX "employee_scheduled_timing_changes_effective_from_idx" ON "employee_scheduled_timing_changes"("effective_from");

-- AddForeignKey
ALTER TABLE "employee_scheduled_timing_changes" ADD CONSTRAINT "employee_scheduled_timing_changes_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
