-- AlterTable
ALTER TABLE "users" ADD COLUMN "allowed_class_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
