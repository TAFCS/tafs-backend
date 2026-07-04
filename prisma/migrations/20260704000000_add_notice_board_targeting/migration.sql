-- AlterTable: employee_notice_posts — add class_ids and section_ids
ALTER TABLE "employee_notice_posts" ADD COLUMN "class_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "employee_notice_posts" ADD COLUMN "section_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- GIN indexes for employee_notice_posts
CREATE INDEX "employee_notice_posts_class_ids_idx" ON "employee_notice_posts" USING GIN ("class_ids");
CREATE INDEX "employee_notice_posts_section_ids_idx" ON "employee_notice_posts" USING GIN ("section_ids");

-- AlterTable: notice_board_posts — add student_ccs
ALTER TABLE "notice_board_posts" ADD COLUMN "student_ccs" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- GIN index for notice_board_posts
CREATE INDEX "notice_board_posts_student_ccs_idx" ON "notice_board_posts" USING GIN ("student_ccs");
