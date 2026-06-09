-- CreateTable (idempotent — table may already exist from manual/prior deploy)
CREATE TABLE IF NOT EXISTS "zk_push_logs" (
    "id" SERIAL NOT NULL,
    "sn" VARCHAR(100) NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zk_push_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "zk_push_logs_sn_idx" ON "zk_push_logs"("sn");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "zk_push_logs_received_at_idx" ON "zk_push_logs"("received_at" DESC);
