-- TAFSD-447: configurable ticket lanes and a versioned question tree.
-- Additive only: new tables plus nullable columns.

CREATE TYPE "TicketFlowStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

CREATE TABLE "ticket_flows" (
    "id" SERIAL NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TicketFlowStatus" NOT NULL,
    "tree" JSONB NOT NULL,
    "notes" VARCHAR(500),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_from" INTEGER,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(255),
    "updated_at" TIMESTAMP(6) NOT NULL,
    "updated_by" VARCHAR(255),
    "published_at" TIMESTAMP(6),
    "published_by" VARCHAR(255),
    "archived_at" TIMESTAMP(6),
    CONSTRAINT "ticket_flows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_flows_version_key" ON "ticket_flows"("version");
CREATE INDEX "ticket_flows_status_idx" ON "ticket_flows"("status");
-- At most one draft and one published version.
CREATE UNIQUE INDEX "ticket_flows_one_draft" ON "ticket_flows"("status") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "ticket_flows_one_published" ON "ticket_flows"("status") WHERE "status" = 'PUBLISHED';

CREATE TABLE "ticket_lanes" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_ur" VARCHAR(80),
    "icon" VARCHAR(40) NOT NULL,
    "color" VARCHAR(9) NOT NULL,
    "legacy_category" "TicketCategory" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "ticket_lanes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_lanes_key_key" ON "ticket_lanes"("key");

ALTER TABLE "support_tickets"
    ADD COLUMN "lane_id" INTEGER,
    ADD COLUMN "flow_version" INTEGER,
    ADD COLUMN "leaf_node_key" VARCHAR(40),
    ADD COLUMN "flow_path" JSONB;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_lane_id_fkey"
    FOREIGN KEY ("lane_id") REFERENCES "ticket_lanes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "support_tickets_lane_id_idx" ON "support_tickets"("lane_id");

ALTER TABLE "ticket_routing_rules" ADD COLUMN "node_key" VARCHAR(40);
