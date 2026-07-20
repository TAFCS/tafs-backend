-- Widen guardian text fields that parents commonly fill with long values
-- (education / organization were truncating approvals with Prisma P2000).
ALTER TABLE "guardians"
  ALTER COLUMN "education_level" TYPE VARCHAR(255),
  ALTER COLUMN "organization" TYPE VARCHAR(255);
