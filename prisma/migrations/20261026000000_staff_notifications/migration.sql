-- TAFSD-429: a staff member's own notifications, listed under the webapp's bell.
CREATE TABLE "staff_notifications" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" VARCHAR(50) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "body" TEXT NOT NULL,
    "link" VARCHAR(500),
    "entity_type" VARCHAR(50),
    "entity_id" VARCHAR(100),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(6),

    CONSTRAINT "staff_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "staff_notifications_user_id_created_at_idx" ON "staff_notifications"("user_id", "created_at" DESC);

ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
