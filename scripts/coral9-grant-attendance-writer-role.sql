-- ============================================================
-- Run this in CORAL9's Supabase SQL editor — NOT against TAFS's own database.
-- It provisions the scoped role that CORAL9_DATABASE_URL (used by
-- src/modules/attendance/coral9-attendance-writer.service.ts) must connect as.
--
-- A Postgres role for the TAFS attendance writer, and nothing else.
-- Run this, then hand TAFS a connection string built from THIS role — never
-- coral9's own application DATABASE_URL (the owner/postgres role).
--
-- Why it matters: coral9's own app connection string can read
-- users.password_hash, the sessions table, the encrypted secrets vault,
-- invoices and every chat message. The service on the other end needs to do
-- exactly one thing — append a row to attendance_punches — so that is all it
-- gets.
--
-- Note what is deliberately NOT granted:
--   * no UPDATE or DELETE on attendance_punches. The punch log is append-only;
--     a compromised or buggy writer can add a bogus punch (visible to the whole
--     team on the board) but cannot quietly erase or rewrite history.
--   * no access to users.password_hash. The column-level grant below lists the
--     six columns the writer actually reads. `grant select on users` WITHOUT a
--     column list would hand over the hashes — that is the mistake this file
--     exists to prevent.
--   * no access to any other table at all.
-- ============================================================

-- ---- 1. The role ------------------------------------------------------------
-- Generate a long random password and put it somewhere you can find it:
--   openssl rand -base64 30
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'coral9_attendance_writer') then
    create role coral9_attendance_writer login password 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
  end if;
end $$;

-- Supabase's pooler needs the role to be able to reach the database at all.
grant connect on database postgres to coral9_attendance_writer;
grant usage   on schema   public   to coral9_attendance_writer;

-- ---- 2. Reading just enough of `users` to resolve a code --------------------
-- Exactly the columns the lookup touches. Adding a column here is a decision;
-- it should never happen by reflex.
grant select (id, full_name, attendance_code, deleted_at, is_active, account_type)
  on users to coral9_attendance_writer;

-- ---- 3. Appending to the punch log -----------------------------------------
grant select, insert on attendance_punches to coral9_attendance_writer;

-- ---- 4. Make sure nothing else leaked in ------------------------------------
-- Supabase creates tables owned by `postgres`; default privileges usually mean
-- a fresh role has nothing, but revoke explicitly rather than assume.
revoke all on all tables    in schema public from coral9_attendance_writer;
revoke all on all functions in schema public from coral9_attendance_writer;
revoke all on all sequences in schema public from coral9_attendance_writer;

-- ...then re-grant only the two above (the revoke above is a blunt instrument).
grant select (id, full_name, attendance_code, deleted_at, is_active, account_type)
  on users to coral9_attendance_writer;
grant select, insert on attendance_punches to coral9_attendance_writer;

-- ---- 5. Verify --------------------------------------------------------------
-- Should list ONLY: attendance_punches (INSERT, SELECT) and users (SELECT on
-- the six named columns). If password_hash appears here, stop and fix it.
select table_name, privilege_type, column_name
from information_schema.column_privileges
where grantee = 'coral9_attendance_writer'
order by table_name, column_name, privilege_type;

select table_name, privilege_type
from information_schema.table_privileges
where grantee = 'coral9_attendance_writer'
order by table_name, privilege_type;

-- ---- 6. The connection string to hand TAFS ---------------------------------
-- Take coral9's app DATABASE_URL and swap the user and password. Use the
-- TRANSACTION pooler (port 6543) for a long-lived service like this:
--
--   postgresql://coral9_attendance_writer.<project-ref>:<password>@<pooler-host>:6543/postgres
--
-- Supabase's pooler expects the username in `role.project-ref` form — copy the
-- shape from coral9's existing URL, replacing only the role name before the dot.
--
-- Set the result as CORAL9_DATABASE_URL in TAFS's deploy platform secret
-- manager. Do not commit it to any file, TAFS's .env included.
