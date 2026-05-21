-- AlterTable (idempotent: column may already exist from manual/schema sync)
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "cnic" VARCHAR(15);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "students_cnic_key" ON "students"("cnic");
