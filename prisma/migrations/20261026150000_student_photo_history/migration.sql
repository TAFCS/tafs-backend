-- CreateTable
CREATE TABLE IF NOT EXISTS "student_photo_history" (
    "id" SERIAL NOT NULL,
    "student_id" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "photo_type" VARCHAR(50) DEFAULT 'standard',
    "uploaded_by" VARCHAR(255),
    "uploaded_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_photo_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "student_photo_history_student_id_idx" ON "student_photo_history"("student_id");
CREATE INDEX IF NOT EXISTS "student_photo_history_student_id_uploaded_at_idx" ON "student_photo_history"("student_id", "uploaded_at");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'student_photo_history_student_id_fkey'
    ) THEN
        ALTER TABLE "student_photo_history" ADD CONSTRAINT "student_photo_history_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Back-fill one row per student from current photograph_url
INSERT INTO "student_photo_history" ("student_id", "url", "photo_type", "uploaded_by", "uploaded_at")
SELECT 
    s."cc", 
    s."photograph_url", 
    'standard', 
    'system_backfill', 
    COALESCE(s."doa", s."created_at", CURRENT_TIMESTAMP)
FROM "students" s
WHERE s."photograph_url" IS NOT NULL 
  AND TRIM(s."photograph_url") <> ''
  AND NOT EXISTS (
      SELECT 1 FROM "student_photo_history" sph 
      WHERE sph."student_id" = s."cc"
  );
