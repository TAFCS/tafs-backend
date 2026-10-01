-- Support ticket routing becomes data instead of code (TAFSD-231).
--
-- Before this, SupportTicketsService.resolveRouting hardcoded the destinations:
-- fees -> the FINANCE_CLERK pool, general-with-child -> the principal matched on
-- users.campus_id/allowed_class_ids, general-without-child -> the oldest
-- GENERAL_RESPONDENT. Admins now edit rules and queues from the dashboard.
--
-- The seed at the bottom reproduces that behaviour exactly, plus any overrides
-- that were set in app_config 'support_tickets.routing_overrides', so routing
-- does not change on deploy.

-- CreateEnum
CREATE TYPE "TicketQueueAssignment" AS ENUM ('POOL', 'AUTO');

-- CreateEnum
CREATE TYPE "TicketChildMatch" AS ENUM ('ANY', 'WITH_CHILD', 'NO_CHILD');

-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "routed_queue_id" INTEGER,
ADD COLUMN     "routed_rule_id" INTEGER,
ADD COLUMN     "routing_note" VARCHAR(500);

-- CreateTable
CREATE TABLE "ticket_queues" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "category" "TicketCategory" NOT NULL,
    "assignment" "TicketQueueAssignment" NOT NULL DEFAULT 'POOL',
    "allow_forward" BOOLEAN NOT NULL DEFAULT false,
    "is_fallback" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,
    "updated_by" VARCHAR(255),

    CONSTRAINT "ticket_queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_queue_members" (
    "queue_id" INTEGER NOT NULL,
    "user_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_queue_members_pkey" PRIMARY KEY ("queue_id","user_id")
);

-- CreateTable
CREATE TABLE "ticket_routing_rules" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" "TicketCategory" NOT NULL,
    "child_match" "TicketChildMatch" NOT NULL DEFAULT 'ANY',
    "campus_id" INTEGER,
    "segment_id" INTEGER,
    "class_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "subtopic" VARCHAR(100),
    "target_user_id" TEXT,
    "target_queue_id" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,
    "updated_by" VARCHAR(255),

    CONSTRAINT "ticket_routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ticket_queues_name_key" ON "ticket_queues"("name");

-- CreateIndex
CREATE INDEX "ticket_queue_members_user_id_idx" ON "ticket_queue_members"("user_id");

-- CreateIndex
CREATE INDEX "ticket_routing_rules_category_is_active_idx" ON "ticket_routing_rules"("category", "is_active");

-- CreateIndex
CREATE INDEX "support_tickets_routed_queue_id_status_idx" ON "support_tickets"("routed_queue_id", "status");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_routed_queue_id_fkey" FOREIGN KEY ("routed_queue_id") REFERENCES "ticket_queues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_routed_rule_id_fkey" FOREIGN KEY ("routed_rule_id") REFERENCES "ticket_routing_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_queue_members" ADD CONSTRAINT "ticket_queue_members_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "ticket_queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_queue_members" ADD CONSTRAINT "ticket_queue_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_routing_rules" ADD CONSTRAINT "ticket_routing_rules_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_routing_rules" ADD CONSTRAINT "ticket_routing_rules_target_queue_id_fkey" FOREIGN KEY ("target_queue_id") REFERENCES "ticket_queues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ticket_routing_rules" ALTER COLUMN "class_ids" SET NOT NULL;

-- A rule targets a person or a queue, never both. Neither is allowed so that
-- deleting a target (ON DELETE SET NULL) never fails; the health check flags it.
ALTER TABLE "ticket_routing_rules"
    ADD CONSTRAINT "ticket_routing_rules_single_target"
    CHECK (num_nonnulls("target_user_id", "target_queue_id") <= 1);

-- One last-resort queue per category.
CREATE UNIQUE INDEX "ticket_queues_one_fallback_per_category"
    ON "ticket_queues"("category") WHERE "is_fallback";

-- ─── Seed: today's routing ──────────────────────────────────────────────────

INSERT INTO "ticket_queues" ("name", "category", "assignment", "allow_forward", "is_fallback", "updated_at", "updated_by")
VALUES
    ('Finance',      'FINANCIAL', 'POOL', false, true, now(), 'migration'),
    ('General desk', 'GENERAL',   'AUTO', true,  true, now(), 'migration');

INSERT INTO "ticket_queue_members" ("queue_id", "user_id", "sort_order")
SELECT q."id", u."id", (row_number() OVER (PARTITION BY q."id" ORDER BY u."created_at"))::int - 1
FROM "users" u
JOIN "ticket_queues" q
  ON (q."name" = 'Finance'      AND u."role" = 'FINANCE_CLERK')
  OR (q."name" = 'General desk' AND u."role" = 'GENERAL_RESPONDENT')
WHERE u."is_active" AND u."deleted_at" IS NULL;

INSERT INTO "ticket_routing_rules" ("name", "category", "child_match", "target_queue_id", "updated_at", "updated_by")
SELECT 'Fees & payments', 'FINANCIAL'::"TicketCategory", 'ANY'::"TicketChildMatch", "id", now(), 'migration' FROM "ticket_queues" WHERE "name" = 'Finance'
UNION ALL
SELECT 'General, not about a child', 'GENERAL'::"TicketCategory", 'NO_CHILD'::"TicketChildMatch", "id", now(), 'migration' FROM "ticket_queues" WHERE "name" = 'General desk';

-- app_config overrides (set as a stopgap before this table existed).
WITH overrides AS (
    SELECT (o->>'campus_id')::int AS campus_id,
           COALESCE(ARRAY(SELECT jsonb_array_elements_text(o->'class_ids')::int), ARRAY[]::int[]) AS class_ids,
           o->>'user_id' AS user_id
    FROM "app_config" c, jsonb_array_elements(c."value"::jsonb) o
    WHERE c."key" = 'support_tickets.routing_overrides'
)
INSERT INTO "ticket_routing_rules" ("name", "category", "child_match", "campus_id", "class_ids", "target_user_id", "updated_at", "updated_by")
SELECT 'Child tickets: ' || cp."campus_name" || ' -> ' || u."full_name",
       'GENERAL', 'WITH_CHILD', o.campus_id, o.class_ids, u."id", now(), 'migration'
FROM overrides o
JOIN "users" u ON u."id" = o.user_id
LEFT JOIN "campuses" cp ON cp."id" = o.campus_id;

-- One rule per principal, mirroring the old campus/class-band lookup. Inactive
-- principals keep their rule so the dashboard shows the gap; routing skips them.
-- A campus-wide override replaces the campus-wide principal on that campus.
INSERT INTO "ticket_routing_rules" ("name", "category", "child_match", "campus_id", "class_ids", "target_user_id", "updated_at", "updated_by")
SELECT 'Principal: ' || u."full_name",
       'GENERAL', 'WITH_CHILD', u."campus_id", u."allowed_class_ids", u."id", now(), 'migration'
FROM "users" u
WHERE u."role" = 'PRINCIPAL'
  AND u."deleted_at" IS NULL
  AND u."campus_id" IS NOT NULL
  AND NOT (
      cardinality(u."allowed_class_ids") = 0
      AND EXISTS (
          SELECT 1 FROM "ticket_routing_rules" r
          WHERE r."updated_by" = 'migration' AND r."target_user_id" IS NOT NULL
            AND r."campus_id" = u."campus_id" AND cardinality(r."class_ids") = 0
      )
  );

DELETE FROM "app_config" WHERE "key" = 'support_tickets.routing_overrides';

-- Existing tickets join the queue that matches the lane they were routed to.
UPDATE "support_tickets" t
SET "routed_queue_id" = q."id"
FROM "ticket_queues" q
WHERE (q."name" = 'Finance'      AND t."routed_role" = 'FINANCE_CLERK')
   OR (q."name" = 'General desk' AND t."routed_role" = 'GENERAL_RESPONDENT');
