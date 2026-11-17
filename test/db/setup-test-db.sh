#!/usr/bin/env bash
# Build a throwaway test database from scratch: wipe the public schema, create
# every table from schema.prisma, then add the DB-only objects (triggers,
# partial unique indexes, CHECKs) from test/db/db-only-objects.sql.
#
# Why not `prisma migrate deploy`: prisma/migrations does not apply to an empty
# database (its first migration UPDATEs voucher_heads, which nothing creates),
# so the history only works on top of the existing production database.
#
# It DROPS the public schema, so it refuses to run unless DATABASE_URL points at
# localhost / 127.0.0.1 / a `postgres` service container AND the database name
# contains "test". It never reads .env. Usage:
#
#   DATABASE_URL=postgresql://postgres@localhost:55432/tafs_test bash test/db/setup-test-db.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

: "${DATABASE_URL:?DATABASE_URL must be set explicitly (never from .env)}"

# Prisma's datasource also reads DIRECT_URL, and migrate/db commands prefer it.
# Pin it to the same throwaway DB so a stray DIRECT_URL can never be used.
export DIRECT_URL="$DATABASE_URL"
export PRISMA_HIDE_UPDATE_MESSAGE=1

host=$(node -e 'const u=new URL(process.env.DATABASE_URL);process.stdout.write(u.hostname)')
db=$(node -e 'const u=new URL(process.env.DATABASE_URL);process.stdout.write(u.pathname.slice(1))')
case "$host" in
  localhost|127.0.0.1|postgres) ;;
  *) echo "refusing: DATABASE_URL host '$host' is not a local throwaway database" >&2; exit 1 ;;
esac
case "$db" in
  *test*) ;;
  *) echo "refusing: database name '$db' does not contain 'test'" >&2; exit 1 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "› resetting schema public on $host/$db"
printf 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n' > "$tmp/reset.sql"
npx prisma db execute --schema prisma/schema.prisma --file "$tmp/reset.sql"

echo "› creating tables from prisma/schema.prisma"
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > "$tmp/baseline.sql"
npx prisma db execute --schema prisma/schema.prisma --file "$tmp/baseline.sql"

echo "› adding DB-only objects (triggers, partial indexes, checks)"
npx prisma db execute --schema prisma/schema.prisma --file test/db/db-only-objects.sql

echo "✓ test database ready"
