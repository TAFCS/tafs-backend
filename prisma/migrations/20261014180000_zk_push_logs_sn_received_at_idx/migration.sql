-- TAFSD-326: latest push per device as one index lookup.
-- CreateIndex
CREATE INDEX "zk_push_logs_sn_received_at_idx" ON "zk_push_logs"("sn", "received_at");

-- DropIndex (covered by the composite index)
DROP INDEX "zk_push_logs_sn_idx";
