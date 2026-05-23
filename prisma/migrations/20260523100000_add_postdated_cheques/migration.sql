-- 1. If table postdated_cheques exists, temporarily cast status column to VARCHAR to release the enum dependency
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'postdated_cheques') THEN
        ALTER TABLE "postdated_cheques" ALTER COLUMN "status" TYPE VARCHAR(50);
    END IF;
END $$;

-- 2. Drop the old enum type if it exists
DROP TYPE IF EXISTS "PostdatedChequeStatus";

-- 3. Re-create the enum type with all values including CANCELLED
CREATE TYPE "PostdatedChequeStatus" AS ENUM ('PENDING', 'CASHED', 'BOUNCED', 'RETURNED', 'CANCELLED');

-- 4. Create the postdated_cheques table if it doesn't exist (using the newly created enum)
CREATE TABLE IF NOT EXISTS "postdated_cheques" (
    "id" SERIAL NOT NULL,
    "student_id" INTEGER NOT NULL,
    "cheque_number" VARCHAR(50) NOT NULL,
    "bank_name" VARCHAR(100),
    "amount" DECIMAL(12,2) NOT NULL,
    "cheque_date" DATE NOT NULL,
    "received_date" DATE NOT NULL,
    "received_by" VARCHAR(255),
    "status" "PostdatedChequeStatus" NOT NULL DEFAULT 'PENDING',
    "cashed_date" DATE,
    "cashed_by" VARCHAR(255),
    "notes" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "postdated_cheques_pkey" PRIMARY KEY ("id")
);

-- 5. If the table already existed, cast the status column back to the new enum type
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'postdated_cheques' AND column_name = 'status' AND data_type = 'character varying') THEN
        ALTER TABLE "postdated_cheques" ALTER COLUMN "status" TYPE "PostdatedChequeStatus" USING status::"PostdatedChequeStatus";
        ALTER TABLE "postdated_cheques" ALTER COLUMN "status" SET DEFAULT 'PENDING';
    END IF;
END $$;

-- 6. Create indexes if not exists
CREATE INDEX IF NOT EXISTS "postdated_cheques_student_id_idx" ON "postdated_cheques"("student_id");
CREATE INDEX IF NOT EXISTS "postdated_cheques_status_idx" ON "postdated_cheques"("status");
CREATE INDEX IF NOT EXISTS "postdated_cheques_cheque_date_idx" ON "postdated_cheques"("cheque_date");

-- 7. Add foreign key constraints
ALTER TABLE "postdated_cheques" DROP CONSTRAINT IF EXISTS "postdated_cheques_student_id_fkey";
ALTER TABLE "postdated_cheques" ADD CONSTRAINT "postdated_cheques_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "postdated_cheques" DROP CONSTRAINT IF EXISTS "postdated_cheques_received_by_fkey";
ALTER TABLE "postdated_cheques" ADD CONSTRAINT "postdated_cheques_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "postdated_cheques" DROP CONSTRAINT IF EXISTS "postdated_cheques_cashed_by_fkey";
ALTER TABLE "postdated_cheques" ADD CONSTRAINT "postdated_cheques_cashed_by_fkey" FOREIGN KEY ("cashed_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
