-- TAFSD-544: release exam documents to the parent app. The document records the
-- release; the family sees a Notice Board card (one per document) and a push.

-- AlterTable
ALTER TABLE "exam_documents" ADD COLUMN "released_at" TIMESTAMP(6),
ADD COLUMN "released_by" VARCHAR(100),
ADD COLUMN "release_message" VARCHAR(500);

-- CreateTable
CREATE TABLE "exam_document_notifications" (
    "id" SERIAL NOT NULL,
    "family_id" INTEGER NOT NULL,
    "student_cc" INTEGER NOT NULL,
    "exam_document_id" INTEGER NOT NULL,
    "doc_type" VARCHAR(30) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "body" TEXT NOT NULL,
    "message" VARCHAR(500),
    "read_at" TIMESTAMP(6),
    "opened_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_document_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exam_document_notifications_exam_document_id_key" ON "exam_document_notifications"("exam_document_id");

-- CreateIndex
CREATE INDEX "exam_document_notifications_family_id_created_at_idx" ON "exam_document_notifications"("family_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "exam_document_notifications" ADD CONSTRAINT "exam_document_notifications_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_document_notifications" ADD CONSTRAINT "exam_document_notifications_student_cc_fkey" FOREIGN KEY ("student_cc") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_document_notifications" ADD CONSTRAINT "exam_document_notifications_exam_document_id_fkey" FOREIGN KEY ("exam_document_id") REFERENCES "exam_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
