Flow 1 — Student campus-wide holiday (core path)
1. Add holiday (calendar + auto-sync)
Log in as SUPER_ADMIN
Go to /hr/calendar
Tab: Student Calendar
Select campus
Click Add Holiday
Date: a weekday (e.g. tomorrow if it’s Mon–Fri)
Type: Holiday / Day off
Description: e.g. Test Holiday
Scope: leave class/section empty (= whole campus)
Save
Expected immediately

Success message mentions attendance synced
Month grid: date shows red (holiday)
Table row: Type = Holiday, Scope = Whole campus
Backend behavior (auto on save)

Creates/updates attendance_student_daily with status = EXCUSED, source = SYSTEM
Same for all active staff on that campus (attendance_staff_daily)
2. Student dashboard
Go to /hr/student-attendance-dashboard

Same campus, class/section optional, same date
Sky banner: “Non-working day…”
Students show EXCUSED badge
Summary includes Excused count
3. Staff register
Go to /hr/staff-register

Same campus + date
Holiday banner
Rows show EXCUSED — Test Holiday
Status buttons and notes disabled
Save should only affect working-day staff (off-day rows excluded)
4. Parent app (Flutter)
Open Attendance (drawer or home calendar icon) for a linked student.

That date should show as off/holiday (purple), not absent
Detail panel: holiday description
Flow 2 — Manual “Apply to attendance” (late holiday)
Use this when you want to test sync without re-saving the calendar entry.

On /hr/calendar, use the amber Apply holiday attendance manually panel
Pick the holiday date → Apply to attendance
Expected

Success: X students and Y staff marked EXCUSED
If some records were manually marked before, message may include skipped_manual
Note: UI does not expose force; manual records are skipped by design. To test force you’d call the API with { force: true } via Postman/curl.

Flow 3 — Scoped student holiday (class/section)
/hr/calendar → Add Holiday on a weekday
Set Class (and optionally Section)
Save
Expected

Only students in that scope get EXCUSED on the dashboard
Students in other classes on same campus: normal (present/absent/blank), not excused
Parent app: only affected students see holiday on that date
Good check: two students, same campus, different classes — only one should be EXCUSED.

Flow 4 — Open weekend (WORKDAY override)
Pick a Saturday or Sunday (or next weekend)
Click Open Weekend (or Add with type Working day override)
Save
Expected

Month grid: green (working day override)
That date is not auto-EXCUSED
Student dashboard: no holiday banner for that date; students show normal attendance state
Parent app: date is not a weekend/holiday off day
Validation: Try Open Weekend on a weekday — should error (backend + UI block it).

Flow 5 — Staff custom schedule (6-day / custom week)
/hr/employees/{id}/edit
Enable Custom weekly schedule
e.g. mark Saturday working, Sunday off (or use 6-day preset)
Save employee
Test

Add a staff-scoped holiday on a day that is off for that employee but working for others (or test Saturday with/without custom schedule)
/hr/staff-register: employee on off day → EXCUSED; employee on working day → normal marking
Staff resolution uses days_per_week + optional employee_work_schedules override.

Flow 6 — A-Level roll call on holiday
Go to /hr/roll-call
Select campus + AS/A2 class + section
Date = your holiday from Flow 1
Load session
Expected

Session status SKIPPED
Skip reason: Holiday: Test Holiday
Sky banner on page
Mark present/absent disabled
On a normal working day, session should be DRAFT and marking works.

Flow 7 — Biometric suppressed on holiday
On a holiday date:

/hr/student-attendance-dashboard → Simulate Fingerprint Scan (SUPER_ADMIN) for a student
or staff dashboard simulate scan
Scan should not create/update clock-in for that day (processor skips non-working days)
On a working day, simulate scan should create/update attendance as before.

Flow 8 — Delete holiday (re-sync)
/hr/calendar → delete the test holiday
Success mentions re-sync
Expected

Auto-sync runs again for that date
Students/staff no longer forced EXCUSED unless still off by default (e.g. weekend)
Dashboards/register update after refresh
Flow 9 — Cron (optional)
Cron runs at 00:05 UTC and 01:00 UTC (~6 AM PKT safety net).

To test without waiting:

Use Apply to attendance for today (same as cron effect for one campus/date), or
Temporarily trigger sync via API: POST /api/v1/hr/calendar/sync-attendance with { campus_id, date }