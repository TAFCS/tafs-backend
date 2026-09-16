-- campuses.campus_prefix is for HR employee codes (GEJ, GKF, NNN), not student G.R. (KF-A, A-N).
-- Normalize known branches and fix rows that still hold student-style prefixes.

UPDATE campuses
SET campus_prefix = 'GEJ'
WHERE id = 1
   OR UPPER(campus_name) LIKE '%JOHAR%';

UPDATE campuses
SET campus_prefix = 'GKF'
WHERE id = 2
   OR UPPER(campus_name) LIKE '%KANEEZ FATIMA%'
   OR UPPER(TRIM(campus_prefix)) IN ('KF-A', 'KFA');

UPDATE campuses
SET campus_prefix = 'NNN'
WHERE id = 3
   OR UPPER(campus_name) LIKE '%NORTH NAZIMABAD%'
   OR UPPER(TRIM(campus_prefix)) IN ('A-N', 'AN');

-- Legacy alias sometimes stored for Johar
UPDATE campuses
SET campus_prefix = 'GEJ'
WHERE UPPER(TRIM(campus_prefix)) = 'JHR';
