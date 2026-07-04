-- CreateEnum
CREATE TYPE "otp_purpose" AS ENUM ('PARENT_SIGNUP', 'PARENT_FORGOT_PASSWORD', 'STAFF_FORGOT_PASSWORD');

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" TEXT NOT NULL,
    "purpose" "otp_purpose" NOT NULL,
    "email" VARCHAR(100) NOT NULL,
    "code_hash" VARCHAR(255) NOT NULL,
    "family_id" INTEGER,
    "user_id" TEXT,
    "cnic" VARCHAR(15),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "consumed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_otp_codes_lookup" ON "otp_codes"("email", "purpose", "consumed_at", "expires_at");

-- CreateIndex
CREATE INDEX "idx_otp_codes_family" ON "otp_codes"("family_id", "purpose");

-- CreateIndex
CREATE INDEX "idx_otp_codes_user" ON "otp_codes"("user_id", "purpose");
