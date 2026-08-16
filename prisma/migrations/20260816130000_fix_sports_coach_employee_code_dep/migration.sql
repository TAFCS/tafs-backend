-- SPORTS_COACH was incorrectly seeded with employee_code_dep '05' (that code
-- actually belongs to VISITING_FACULTY, added in the prior migration). A
-- regular sports coach is grouped with the standard teaching staff, code '02'.
-- This only changes the category's default for *future* hires — existing
-- employees keep the employee_code_dep already stored on their own profile.
UPDATE "staff_categories" SET "employee_code_dep" = '02' WHERE "code" = 'SPORTS_COACH';
