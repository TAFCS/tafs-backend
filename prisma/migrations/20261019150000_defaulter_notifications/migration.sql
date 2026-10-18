-- TAFSD-384: "Notify through app" sends from the Defaulters report.
CREATE TABLE "defaulter_notifications" (
    "id" SERIAL NOT NULL,
    "student_id" INTEGER NOT NULL,
    "notice_post_id" INTEGER NOT NULL,
    "sent_by" VARCHAR(255) NOT NULL,
    "sent_by_name" VARCHAR(255),
    "sent_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrears_outstanding" DECIMAL(12,2) NOT NULL,
    "months_behind" INTEGER NOT NULL,
    "as_of_date" DATE NOT NULL,

    CONSTRAINT "defaulter_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "defaulter_notifications_student_id_sent_at_idx" ON "defaulter_notifications"("student_id", "sent_at");
