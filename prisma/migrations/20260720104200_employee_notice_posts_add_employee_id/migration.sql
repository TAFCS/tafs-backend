-- AlterTable
ALTER TABLE "employee_notice_posts" ADD COLUMN "employee_id" INTEGER;

-- CreateIndex
CREATE INDEX "employee_notice_posts_employee_id_idx" ON "employee_notice_posts"("employee_id");

-- AddForeignKey
ALTER TABLE "employee_notice_posts" ADD CONSTRAINT "employee_notice_posts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
