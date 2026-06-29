-- Require leave_types.code after backfill from seed/migration

UPDATE "leave_types" SET "code" = 'SICK' WHERE "name" = 'Sick Leave' AND "code" IS NULL;
UPDATE "leave_types" SET "code" = 'CASUAL' WHERE "name" = 'Casual Leave' AND "code" IS NULL;
UPDATE "leave_types" SET "code" = 'ANNUAL' WHERE "name" = 'Annual Leave' AND "code" IS NULL;
UPDATE "leave_types" SET "code" = 'UNPAID' WHERE "name" = 'Unpaid Leave' AND "code" IS NULL;

ALTER TABLE "leave_types" ALTER COLUMN "code" SET NOT NULL;
