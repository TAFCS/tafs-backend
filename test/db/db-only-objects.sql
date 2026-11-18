-- Database objects that live in prisma/migrations but that schema.prisma cannot
-- express: triggers, partial unique indexes and CHECK constraints.
--
-- Why this file exists: prisma/migrations does not apply to an empty database.
-- Its first migration (20260315000000_snapshot_billing_...) UPDATEs
-- voucher_heads, which no earlier migration creates — the history starts from a
-- database that already existed. So the throwaway test database is built as
--
--   1. `prisma migrate diff --from-empty --to-schema-datamodel` (every table,
--      column, FK and plain index schema.prisma knows about), then
--   2. this file (everything it doesn't).
--
-- See test/db/setup-test-db.sh. test/db/db-only-objects.db-spec.ts parses the
-- migrations and fails CI if a migration adds a trigger, partial unique index or
-- CHECK constraint that is missing here, so this file cannot silently drift.
--
-- Copied verbatim from the named migration. Never edit prisma/migrations to make
-- the test DB work: `prisma migrate deploy` runs those against production.

-- ── 20260801000000_enforce_student_fee_amount_invariants ────────────────────
-- student_fees.amount is always a whole number; no scholarship => the
-- "after discount" stage IS the final amount (CLAUDE.md invariant 5).
CREATE OR REPLACE FUNCTION enforce_student_fee_amount_invariants()
RETURNS trigger AS $$
BEGIN
    IF NEW.amount IS NOT NULL THEN
        NEW.amount := ROUND(NEW.amount, 0);
    END IF;

    IF COALESCE(NEW.scholarship_percentage, 0) = 0 THEN
        NEW.amount_after_discount := NEW.amount;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_student_fees_amount_invariants ON "student_fees";
CREATE TRIGGER trg_student_fees_amount_invariants
    BEFORE INSERT OR UPDATE ON "student_fees"
    FOR EACH ROW
    EXECUTE FUNCTION enforce_student_fee_amount_invariants();

-- ── 20261116150000_uniform_photo_pending ────────────────────────────────────
CREATE OR REPLACE FUNCTION students_uniform_photo_pending() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.uniform_photo_pending := NEW.cc > 7525;
    RETURN NEW;
  END IF;

  IF NEW.uniform_photo_pending
     AND OLD.photograph_url IS NOT NULL
     AND btrim(OLD.photograph_url) <> ''
     AND NEW.photograph_url IS NOT NULL
     AND btrim(NEW.photograph_url) <> ''
     AND NEW.photograph_url IS DISTINCT FROM OLD.photograph_url
     AND OLD.status NOT IN ('QUICK_ADMISSION', 'SOFT_ADMISSION') THEN
    NEW.uniform_photo_pending := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_students_uniform_photo_pending ON "students";
CREATE TRIGGER trg_students_uniform_photo_pending
  BEFORE INSERT OR UPDATE ON "students"
  FOR EACH ROW EXECUTE FUNCTION students_uniform_photo_pending();

-- ── 20260825170000_employee_loans ───────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "employee_loans_one_active_key"
  ON "employee_loans"("employee_id") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS "employee_loan_txns_deduction_line_key"
  ON "employee_loan_transactions"("loan_id", "payroll_run_line_id")
  WHERE "payroll_run_line_id" IS NOT NULL AND "type" = 'DEDUCTION';

-- ── 20260825120000_employee_security_deposits ───────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "employee_security_deposits_one_open_key"
  ON "employee_security_deposits"("employee_id") WHERE status IN ('ACTIVE', 'COMPLETED');
CREATE UNIQUE INDEX IF NOT EXISTS "employee_security_deposit_txns_deduction_line_key"
  ON "employee_security_deposit_transactions"("deposit_id", "payroll_run_line_id")
  WHERE "payroll_run_line_id" IS NOT NULL AND "type" = 'DEDUCTION';

-- ── 20261031120000_ticket_flow_builder ──────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_flows_one_draft"
  ON "ticket_flows"("status") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_flows_one_published"
  ON "ticket_flows"("status") WHERE "status" = 'PUBLISHED';

-- ── 20260722120000_add_student_progression_periods ─────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "student_progression_periods_one_open_per_student"
  ON "student_progression_periods" ("student_cc") WHERE "valid_to" IS NULL;

-- ── 20260823120000_add_financial_report_snapshots ──────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "financial_report_snapshots_finalized_scope_key"
  ON "financial_report_snapshots"("report_type", "from_date", "to_date", "view", "filters_hash")
  WHERE "status" = 'FINALIZED';

-- ── 20260904120000_add_employee_progression_periods ────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "employee_progression_periods_one_open_per_employee"
  ON "employee_progression_periods" ("employee_id") WHERE "valid_to" IS NULL;

-- ── 20261001120000_ticket_routing_rules ─────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_queues_one_fallback_per_category"
  ON "ticket_queues"("category") WHERE "is_fallback";

-- ── CHECK constraints ───────────────────────────────────────────────────────
-- 20260719120000_campus_section_allocation_rules
ALTER TABLE "campus_sections"
  ADD CONSTRAINT "campus_sections_student_capacity_positive"
  CHECK ("student_capacity" IS NULL OR "student_capacity" > 0);

-- 20260922160000_class_schedule_day_overrides
ALTER TABLE "class_check_in_schedule_days"
  ADD CONSTRAINT "class_check_in_schedule_days_dow_range"
  CHECK ("day_of_week" BETWEEN 0 AND 6);

-- 20261001120000_ticket_routing_rules
ALTER TABLE "ticket_routing_rules"
  ADD CONSTRAINT "ticket_routing_rules_single_target"
  CHECK (num_nonnulls("target_user_id", "target_queue_id") <= 1);

-- 20261114090000_student_document_vault
ALTER TABLE "student_document_types"
  ADD CONSTRAINT "student_document_types_owner_check" CHECK ("owner" IN ('STUDENT', 'GUARDIAN'));
ALTER TABLE "student_document_types"
  ADD CONSTRAINT "student_document_types_origin_check" CHECK ("origin" IN ('PROVIDED', 'GENERATED'));
ALTER TABLE "student_documents"
  ADD CONSTRAINT "student_documents_one_owner_check"
  CHECK (("student_id" IS NOT NULL) <> ("guardian_id" IS NOT NULL));
