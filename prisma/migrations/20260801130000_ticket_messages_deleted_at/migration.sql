-- Soft-delete support for staff ticket messages (own messages only).
ALTER TABLE "ticket_messages" ADD COLUMN "deleted_at" TIMESTAMP(6);

CREATE INDEX "ticket_messages_deleted_at_idx" ON "ticket_messages"("deleted_at");
