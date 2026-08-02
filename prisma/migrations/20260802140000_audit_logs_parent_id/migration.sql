-- Group related audit rows under one parent (one user action → one top-level entry).
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "parent_id" INTEGER;
CREATE INDEX IF NOT EXISTS "audit_logs_parent_id_idx" ON "audit_logs"("parent_id");
DO $$ BEGIN
  ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "audit_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
