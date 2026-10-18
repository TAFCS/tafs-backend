-- TAFSD-372: monthly pay changes scheduled for a future effective date.
CREATE TABLE "employee_scheduled_pay_changes" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "monthly_pay" DECIMAL(12,2),
    "changed_by" VARCHAR(255),
    "notes" VARCHAR(255),
    "recorded_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_scheduled_pay_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "employee_scheduled_pay_changes_employee_id_effective_from_key" ON "employee_scheduled_pay_changes"("employee_id", "effective_from");
CREATE INDEX "employee_scheduled_pay_changes_effective_from_idx" ON "employee_scheduled_pay_changes"("effective_from");

ALTER TABLE "employee_scheduled_pay_changes" ADD CONSTRAINT "employee_scheduled_pay_changes_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
