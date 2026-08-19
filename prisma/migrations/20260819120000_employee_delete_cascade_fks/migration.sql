-- Deleting an employee_profiles row currently fails with a raw FK violation
-- (surfaced to the client as a generic 500) whenever the employee still has
-- teaching_groups or timetable_slots rows, since both FKs were RESTRICT.
-- Cascade them, matching every other employee_id FK on this table.

ALTER TABLE "teaching_groups" DROP CONSTRAINT "teaching_groups_employee_id_fkey";
ALTER TABLE "teaching_groups" ADD CONSTRAINT "teaching_groups_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "timetable_slots" DROP CONSTRAINT "timetable_slots_employee_id_fkey";
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
