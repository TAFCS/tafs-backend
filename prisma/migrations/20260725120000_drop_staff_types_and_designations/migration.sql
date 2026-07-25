-- Remove staff_types and designations: fully replaced by departments -> staff_categories,
-- plus employee_profiles.job_title / job_description free text.
-- No live FK columns reference these tables on employee_profiles.

DROP TABLE IF EXISTS "designations";
DROP TABLE IF EXISTS "staff_types";
