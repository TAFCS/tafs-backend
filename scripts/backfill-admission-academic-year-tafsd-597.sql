-- TAFSD-597: student_admissions.academic_year held the calendar year ("2026")
-- instead of a session, because registration ignored the year picked on the form.
-- This sets each such row to the session the admission was for.
--
-- Rule, per row still holding a bare year:
--   1. The student was promoted after applying (the July 2026 bulk promotion):
--      they were admitted into the session before the promotion's target,
--      e.g. promoted to 2026-2027 -> admitted for 2025-2026.
--   2. Otherwise: the student's own students.academic_year (what the form saved).
--
-- Usage:
--   Preview (read-only):  psql "$URL" -v apply=0 -f this-file
--   Apply:                psql "$URL" -v apply=1 -f this-file
-- Only rows whose academic_year is not already "YYYY-YYYY" are touched, so a
-- second run changes nothing.

\set ON_ERROR_STOP on

\echo '== Planned changes by rule (new_year empty = left unchanged) =='
WITH plan AS (
    WITH bad AS (
        SELECT a.id, a.student_id, a.academic_system, a.application_date, a.academic_year AS old_year
        FROM student_admissions a
        WHERE a.academic_year IS NULL OR a.academic_year !~ '^\d{4}-\d{4}$'
    ),
    promo AS (
        SELECT DISTINCT ON (h.student_cc) h.student_cc, h.academic_year AS promoted_to
        FROM student_academic_history h
        JOIN bad ON bad.student_id = h.student_cc
        WHERE h.change_type = 'PROMOTED'
          AND h.changed_at >= bad.application_date
          AND h.academic_year ~ '^\d{4}-\d{4}$'
        ORDER BY h.student_cc, h.changed_at
    )
    SELECT bad.id,
           bad.student_id,
           bad.academic_system,
           bad.application_date::date AS applied_on,
           bad.old_year,
           s.academic_year AS student_year,
           CASE
               WHEN promo.promoted_to IS NOT NULL THEN
                   (split_part(promo.promoted_to, '-', 1)::int - 1) || '-' || split_part(promo.promoted_to, '-', 1)
               WHEN s.academic_year ~ '^\d{4}-\d{4}$' THEN s.academic_year
           END AS new_year,
           CASE WHEN promo.promoted_to IS NOT NULL THEN 'promoted after applying' ELSE 'student record' END AS rule
    FROM bad
    JOIN students s ON s.cc = bad.student_id
    LEFT JOIN promo ON promo.student_cc = bad.student_id
)
SELECT rule, old_year, new_year, count(*) FROM plan GROUP BY 1, 2, 3 ORDER BY 4 DESC;

\if :apply
    BEGIN;
    WITH plan AS (
        WITH bad AS (
            SELECT a.id, a.student_id, a.academic_system, a.application_date, a.academic_year AS old_year
            FROM student_admissions a
            WHERE a.academic_year IS NULL OR a.academic_year !~ '^\d{4}-\d{4}$'
        ),
        promo AS (
            SELECT DISTINCT ON (h.student_cc) h.student_cc, h.academic_year AS promoted_to
            FROM student_academic_history h
            JOIN bad ON bad.student_id = h.student_cc
            WHERE h.change_type = 'PROMOTED'
              AND h.changed_at >= bad.application_date
              AND h.academic_year ~ '^\d{4}-\d{4}$'
            ORDER BY h.student_cc, h.changed_at
        )
        SELECT bad.id,
               bad.student_id,
               bad.academic_system,
               bad.application_date::date AS applied_on,
               bad.old_year,
               s.academic_year AS student_year,
               CASE
                   WHEN promo.promoted_to IS NOT NULL THEN
                       (split_part(promo.promoted_to, '-', 1)::int - 1) || '-' || split_part(promo.promoted_to, '-', 1)
                   WHEN s.academic_year ~ '^\d{4}-\d{4}$' THEN s.academic_year
               END AS new_year,
               CASE WHEN promo.promoted_to IS NOT NULL THEN 'promoted after applying' ELSE 'student record' END AS rule
        FROM bad
        JOIN students s ON s.cc = bad.student_id
        LEFT JOIN promo ON promo.student_cc = bad.student_id
    )
    UPDATE student_admissions a
    SET academic_year = p.new_year
    FROM plan p
    WHERE a.id = p.id AND p.new_year IS NOT NULL
      AND (a.academic_year IS NULL OR a.academic_year !~ '^\d{4}-\d{4}$');
    \echo '== Remaining rows without a session (expect 0) =='
    SELECT count(*) FROM student_admissions WHERE academic_year IS NULL OR academic_year !~ '^\d{4}-\d{4}$';
    COMMIT;
\else
    \echo '(preview only: run with -v apply=1 to write)'
\endif
