-- Notice board posts can now additionally be scoped by student status and
-- academic year, alongside the existing campus/class/section/student_ccs scope arrays.
ALTER TABLE "notice_board_posts" ADD COLUMN "student_statuses" "student_status"[] NOT NULL DEFAULT ARRAY[]::"student_status"[];
ALTER TABLE "notice_board_posts" ADD COLUMN "academic_years" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "notice_board_posts_student_statuses_idx" ON "notice_board_posts" USING GIN ("student_statuses");
CREATE INDEX "notice_board_posts_academic_years_idx" ON "notice_board_posts" USING GIN ("academic_years");
