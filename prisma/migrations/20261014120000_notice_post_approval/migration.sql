-- TAFSD-314: notice board posts by non-superadmins wait for superadmin approval.
-- Existing posts are already live, so they default to APPROVED.

-- CreateEnum
CREATE TYPE "NoticePostStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "notice_board_posts" ADD COLUMN "status" "NoticePostStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "reviewed_by" VARCHAR(255),
ADD COLUMN "reviewed_at" TIMESTAMP(6),
ADD COLUMN "review_reason" VARCHAR(500);

-- CreateIndex
CREATE INDEX "notice_board_posts_status_idx" ON "notice_board_posts"("status");

-- AddForeignKey
ALTER TABLE "notice_board_posts" ADD CONSTRAINT "notice_board_posts_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
