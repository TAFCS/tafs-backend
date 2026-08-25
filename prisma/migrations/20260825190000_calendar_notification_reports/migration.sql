-- CreateTable
CREATE TABLE "calendar_notification_reports" (
    "id" SERIAL NOT NULL,
    "calendar_day_id" INTEGER,
    "campus_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "day_type" VARCHAR(20) NOT NULL,
    "alert_type" VARCHAR(20) NOT NULL,
    "description" VARCHAR(255),
    "attempted" INTEGER NOT NULL DEFAULT 0,
    "notified" INTEGER NOT NULL DEFAULT 0,
    "already_notified" INTEGER NOT NULL DEFAULT 0,
    "skipped_no_family" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "failures" JSONB,
    "summary" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_notification_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_notification_reports_campus_id_created_at_idx" ON "calendar_notification_reports"("campus_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "calendar_notification_reports_campus_id_date_idx" ON "calendar_notification_reports"("campus_id", "date");

-- AddForeignKey
ALTER TABLE "calendar_notification_reports" ADD CONSTRAINT "calendar_notification_reports_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_notification_reports" ADD CONSTRAINT "calendar_notification_reports_calendar_day_id_fkey" FOREIGN KEY ("calendar_day_id") REFERENCES "academic_calendar_days"("id") ON DELETE SET NULL ON UPDATE CASCADE;
