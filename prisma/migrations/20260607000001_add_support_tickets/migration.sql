-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('GENERAL', 'FINANCIAL');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'ASSIGNED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketSenderType" AS ENUM ('GUARDIAN', 'STAFF');

-- CreateEnum
CREATE TYPE "TicketEventType" AS ENUM ('CREATED', 'CLAIMED', 'TRANSFERRED', 'FORWARDED', 'REPLY_SUBMITTED', 'REPLY_APPROVED', 'REPLY_REJECTED', 'CLOSED_BY_STAFF', 'CLOSED_BY_PARENT');

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "family_id" INTEGER NOT NULL,
    "category" "TicketCategory" NOT NULL,
    "subtopic" VARCHAR(100),
    "student_id" INTEGER,
    "description" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "current_assignee_id" TEXT,
    "routed_role" "StaffRole" NOT NULL,
    "opened_by_guardian_id" INTEGER,
    "closed_by_user_id" TEXT,
    "closed_by_guardian_id" INTEGER,
    "closed_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_snippet" VARCHAR(255),
    "unread_by_staff" INTEGER NOT NULL DEFAULT 0,
    "unread_by_parent" INTEGER NOT NULL DEFAULT 0,
    "staff_last_read_at" TIMESTAMP(3),
    "parent_last_read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "sender_type" "TicketSenderType" NOT NULL,
    "sender_user_id" TEXT,
    "sender_guardian_id" INTEGER,
    "message_type" "ChatMessageType" NOT NULL,
    "content" TEXT NOT NULL,
    "media_metadata" JSONB,
    "status" "MessageStatus" NOT NULL DEFAULT 'APPROVED',
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" SERIAL NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "event_type" "TicketEventType" NOT NULL,
    "actor_user_id" TEXT,
    "actor_guardian_id" INTEGER,
    "from_user_id" TEXT,
    "to_user_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_tickets_family_id_status_idx" ON "support_tickets"("family_id", "status");

-- CreateIndex
CREATE INDEX "support_tickets_status_routed_role_idx" ON "support_tickets"("status", "routed_role");

-- CreateIndex
CREATE INDEX "support_tickets_current_assignee_id_status_idx" ON "support_tickets"("current_assignee_id", "status");

-- CreateIndex
CREATE INDEX "support_tickets_last_message_at_idx" ON "support_tickets"("last_message_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_messages_ticket_id_created_at_idx" ON "ticket_messages"("ticket_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_messages_status_sender_type_idx" ON "ticket_messages"("status", "sender_type");

-- CreateIndex
CREATE INDEX "ticket_events_ticket_id_created_at_idx" ON "ticket_events"("ticket_id", "created_at");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("cc") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_current_assignee_id_fkey" FOREIGN KEY ("current_assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_opened_by_guardian_id_fkey" FOREIGN KEY ("opened_by_guardian_id") REFERENCES "guardians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_closed_by_guardian_id_fkey" FOREIGN KEY ("closed_by_guardian_id") REFERENCES "guardians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_sender_guardian_id_fkey" FOREIGN KEY ("sender_guardian_id") REFERENCES "guardians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actor_guardian_id_fkey" FOREIGN KEY ("actor_guardian_id") REFERENCES "guardians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
