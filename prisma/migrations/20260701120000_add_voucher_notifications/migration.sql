-- CreateTable
CREATE TABLE "voucher_notifications" (
    "id" SERIAL NOT NULL,
    "family_id" INTEGER NOT NULL,
    "student_cc" INTEGER NOT NULL,
    "voucher_id" INTEGER NOT NULL,
    "alert_type" VARCHAR(30) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voucher_notifications_family_id_created_at_idx" ON "voucher_notifications"("family_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "voucher_notifications_voucher_id_alert_type_key" ON "voucher_notifications"("voucher_id", "alert_type");

-- AddForeignKey
ALTER TABLE "voucher_notifications" ADD CONSTRAINT "voucher_notifications_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_notifications" ADD CONSTRAINT "voucher_notifications_student_cc_fkey" FOREIGN KEY ("student_cc") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_notifications" ADD CONSTRAINT "voucher_notifications_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
