# DB test suite

`test/db/**/*.db-spec.ts`: the real `AppModule`, driven over HTTP with
supertest, against a real, throwaway Postgres. Every request goes through
`JwtStaffGuard → PoliciesGuard → TileActionGuard`, the global `ValidationPipe`
and the universal scope checks, with access resolved from the database exactly
as for a real login. CI runs it on every push and PR (`DB tests` in
`.github/workflows/backend.yml`); the image and deploy jobs wait for it.

The unit specs (`src/**/*.spec.ts`, mocked Prisma, no database) are a separate
run: `npx jest`.

## Never against production

The repo's `.env` points at the **production** database. This suite truncates
tables. So:

- it reads `DATABASE_URL` from the environment you pass, never from `.env`
  (nothing in the suite loads `.env`, and the CI job has no `.env`);
- `setup-test-db.sh`, jest's `globalSetup` and every worker refuse to run unless
  the host is `localhost` / `127.0.0.1` / `postgres` **and** the database name
  contains `test`;
- `DIRECT_URL` is pinned to the same URL so Prisma can't fall back to another.

## Run it locally

Start a private Postgres on a spare port (Homebrew Postgres 17 shown; any 16+
works). `LC_ALL` matters on macOS, or the postmaster refuses to start.

```bash
export LC_ALL=en_US.UTF-8
initdb -D /tmp/tafs-pg -U postgres --auth=trust
pg_ctl -D /tmp/tafs-pg -o "-p 55432 -k ''" -l /tmp/tafs-pg.log start
createdb -h localhost -p 55432 -U postgres tafs_test
```

Build the schema, then run the suite:

```bash
DATABASE_URL=postgresql://postgres@localhost:55432/tafs_test npm run test:db:setup
```

```bash
DATABASE_URL=postgresql://postgres@localhost:55432/tafs_test npm run test:db
```

Stop it with `pg_ctl -D /tmp/tafs-pg stop`.

## How the schema is built, and why not `prisma migrate deploy`

`prisma/migrations` does **not** apply to an empty database: the first
migration (`20260315000000_snapshot_billing_remove_amount_from_student_fees`)
`UPDATE`s `voucher_heads`, which no earlier migration creates. The history
starts from a database that already existed, so it only replays on top of
production.

`setup-test-db.sh` therefore:

1. drops and recreates the `public` schema;
2. creates every table, column, FK and index from `schema.prisma`
   (`prisma migrate diff --from-empty --to-schema-datamodel`);
3. applies `db-only-objects.sql`: the triggers, partial unique indexes and CHECK
   constraints that live in migrations but that `schema.prisma` cannot express —
   among them `trg_student_fees_amount_invariants`, which the fee flows depend on.

`db-only-objects.db-spec.ts` replays the migrations' DDL for those three kinds of
object and fails if any one still standing is missing from the test database.
**Adding a trigger, partial unique index or CHECK in a migration? Copy it into
`db-only-objects.sql` too**, or this suite goes red.

Never edit `prisma/migrations` to make the test database work: `prisma migrate
deploy` runs those files against production.

## Writing a spec

- Boot once per file with `bootApp()` (`helpers/app.ts`); seed with
  `seedSchool()` (`helpers/fixtures.ts`): two campuses, an Aug-Jul and an
  Apr-Mar class, fee types 1/2/3 (MTF, annual, caution: the ids the code
  hard-codes), four students, and four users — `admin` (SUPER_ADMIN), `clerk`
  (Student Overrides in full, scoped to campus A), `viewer` (tile only) and
  `noEdit` (full capability with `schedule.edit` denied, so only
  `TileActionGuard` can stop it).
- `client(app, tokenFor(jwt, USERS.clerk)).post('/student-fees/bulk')` sends a
  request as that user. Assert on the response **and** on the rows in the
  database.
- Reset what your tests write in a `beforeEach` (see `student-fees.db-spec.ts`).
- Specs run in one worker (`maxWorkers: 1`); they share one database.
- `forceExit` is on because `AccessSyncService` leaves a 20 s boot-timeout timer
  running after the app closes. Harmless in production, it would otherwise hold
  jest open.
