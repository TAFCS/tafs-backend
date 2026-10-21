-- TAFSD-399: parent login / signup filter families by exact email; the
-- change-request queue filters by status, a family's history by family_id.
CREATE INDEX IF NOT EXISTS "idx_families_email" ON "families"("email");
CREATE INDEX IF NOT EXISTS "idx_parent_change_requests_status_created" ON "parent_change_requests"("status", "created_at");
CREATE INDEX IF NOT EXISTS "idx_parent_change_requests_family" ON "parent_change_requests"("family_id");
