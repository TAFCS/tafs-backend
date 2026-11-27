-- TAFSD-621 audit (read-only). Approved casual leaves that break the casual
-- leave rules enforced from TAFSD-621 on:
--   1. one day only (start_date = end_date)
--   2. permanent staff only (employment_subtype = PERMANENT)
--   3. at most one per calendar month, per employee
--
-- Rule 2 is checked against the employee's subtype TODAY: the database keeps
-- no history of it, so someone made permanent since shows as fine, and
-- someone left since shows with no subtype. join_date is listed so the school
-- can judge.
--
-- Changes nothing (the transaction is read-only). Run:
--   psql "$DATABASE_URL" -f scripts/audit-casual-leave-rules.sql --csv -o casual-leave-audit.csv
BEGIN TRANSACTION READ ONLY;

WITH casual AS (
  SELECT lr.id, lr.employee_id, lr.start_date, lr.end_date, lr.created_at, lr.reviewed_at
  FROM leave_requests lr
  JOIN leave_types lt ON lt.id = lr.leave_type_id
  WHERE lt.code = 'CASUAL' AND lr.status = 'APPROVED'
),
per_month AS (
  -- Every calendar month each request touches.
  SELECT c.id, c.employee_id, to_char(m, 'YYYY-MM') AS month
  FROM casual c
  CROSS JOIN LATERAL generate_series(
    date_trunc('month', c.start_date), date_trunc('month', c.end_date), interval '1 month'
  ) AS m
),
month_counts AS (
  SELECT employee_id, month, count(*) AS approved_in_month
  FROM per_month
  GROUP BY employee_id, month
)
SELECT
  c.id                                         AS leave_request_id,
  ep.employee_code,
  ep.full_name,
  cp.campus_name,
  d.name                                       AS department,
  ep.employment_status,
  ep.employment_subtype                        AS subtype_today,
  ep.join_date,
  c.start_date,
  c.end_date,
  (c.end_date - c.start_date + 1)              AS days,
  (SELECT string_agg(pm.month || ' x' || mc.approved_in_month, ', ' ORDER BY pm.month)
     FROM per_month pm
     JOIN month_counts mc ON mc.employee_id = pm.employee_id AND mc.month = pm.month
    WHERE pm.id = c.id AND mc.approved_in_month > 1) AS months_over_limit,
  concat_ws('; ',
    CASE WHEN c.end_date <> c.start_date THEN 'more than one day' END,
    CASE WHEN ep.employment_subtype IS DISTINCT FROM 'PERMANENT' THEN 'not marked permanent today' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM per_month pm
      JOIN month_counts mc ON mc.employee_id = pm.employee_id AND mc.month = pm.month
      WHERE pm.id = c.id AND mc.approved_in_month > 1
    ) THEN 'more than one in a calendar month' END
  )                                            AS broken_rules,
  c.created_at::date                           AS applied_on,
  c.reviewed_at::date                          AS approved_on
FROM casual c
JOIN employee_profiles ep ON ep.id = c.employee_id
LEFT JOIN campuses cp ON cp.id = ep.campus_id
LEFT JOIN departments d ON d.id = ep.department_id
WHERE c.end_date <> c.start_date
   OR ep.employment_subtype IS DISTINCT FROM 'PERMANENT'
   OR EXISTS (
     SELECT 1 FROM per_month pm
     JOIN month_counts mc ON mc.employee_id = pm.employee_id AND mc.month = pm.month
     WHERE pm.id = c.id AND mc.approved_in_month > 1
   )
ORDER BY cp.campus_name, ep.full_name, c.start_date;

ROLLBACK;
