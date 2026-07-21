-- strip-name-honorifics.sql
--
-- Removes MRS./MR./MS./M. honorific prefixes from employee_profiles.full_name,
-- matching the same HONORIFIC_PREFIX regex already used by
-- scripts/import-employee-hr-data.ts (buildUsername) for generating usernames,
-- now applied to the stored full_name itself DB-wide.

UPDATE employee_profiles
SET full_name = regexp_replace(full_name, '^(MRS\.?|MR\.?|MS\.?|M\.)\s*', '', 'i')
WHERE full_name ~* '^(MRS\.?|MR\.?|MS\.?|M\.)\s*';
