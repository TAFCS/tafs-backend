-- TAFSD-543: the report of each Issue run on an exam schedule: who got a
-- document, who was reprinted, and who was skipped and why. Written once per run.

-- CreateTable
CREATE TABLE "exam_document_runs" (
    "id" SERIAL NOT NULL,
    "schedule_id" INTEGER NOT NULL,
    "label" VARCHAR(300) NOT NULL,
    "requested" INTEGER NOT NULL,
    "issued" INTEGER NOT NULL,
    "reprinted" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "with_gaps" INTEGER NOT NULL DEFAULT 0,
    "students" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "created_by" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_document_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exam_document_runs_schedule_id_created_at_idx" ON "exam_document_runs"("schedule_id", "created_at");

-- AddForeignKey
ALTER TABLE "exam_document_runs" ADD CONSTRAINT "exam_document_runs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "exam_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
