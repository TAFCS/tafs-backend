-- Device pin collision checks look students up by gr_number on every mapping
-- write; without this index that is a sequential scan over the students table.
CREATE INDEX IF NOT EXISTS "idx_students_gr_number" ON "students"("gr_number");
