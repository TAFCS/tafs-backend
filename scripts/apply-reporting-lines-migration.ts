/**
 * TAFSD-327: applies migration 20261015120000_employee_reporting_lines.
 *
 * Does exactly what `npx prisma migrate deploy` does for this one migration:
 * runs its migration.sql and records it in _prisma_migrations (same sha256
 * checksum Prisma uses), all in one transaction, so `prisma migrate status`
 * is clean afterwards. It only creates the new employee_reporting_lines table;
 * no existing table or row is touched.
 *
 *   npx ts-node --transpile-only scripts/apply-reporting-lines-migration.ts           # dry run
 *   npx ts-node --transpile-only scripts/apply-reporting-lines-migration.ts --apply   # apply
 *
 * Safe to re-run: it stops if the migration is already recorded or the table
 * already exists.
 */
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION = '20261015120000_employee_reporting_lines';
const APPLY = process.argv.includes('--apply');

const prisma = new PrismaClient();

/** Splits migration.sql into statements, dropping comment lines. */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const file = join(__dirname, '..', 'prisma', 'migrations', MIGRATION, 'migration.sql');
  const sql = readFileSync(file);
  const checksum = createHash('sha256').update(sql).digest('hex');
  const steps = statements(sql.toString('utf8'));

  const recorded: { finished_at: Date | null; rolled_back_at: Date | null }[] = await prisma.$queryRawUnsafe(
    'SELECT finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = $1',
    MIGRATION,
  );
  const [{ exists }]: { exists: boolean }[] = await prisma.$queryRawUnsafe(
    "SELECT to_regclass('public.employee_reporting_lines') IS NOT NULL AS exists",
  );

  console.log(`Migration: ${MIGRATION}`);
  console.log(`Checksum:  ${checksum}`);
  console.log(`Recorded in _prisma_migrations: ${recorded.length ? 'yes' : 'no'}`);
  console.log(`Table employee_reporting_lines exists: ${exists ? 'yes' : 'no'}`);

  if (recorded.some((r) => r.finished_at && !r.rolled_back_at)) {
    console.log('\nAlready applied. Nothing to do.');
    return;
  }
  if (exists) {
    console.log('\nThe table exists but the migration is not recorded. Stopping: check by hand before going on.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nWill run ${steps.length} statements:`);
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.split('\n')[0]}${s.includes('\n') ? ' …' : ''}`));

  if (!APPLY) {
    console.log('\nDry run. Nothing was changed. Re-run with --apply to apply.');
    return;
  }

  const startedAt = new Date();
  await prisma.$transaction(async (tx) => {
    for (const s of steps) await tx.$executeRawUnsafe(s);
    await tx.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
       VALUES ($1, $2, $3, $4, now(), 1)`,
      randomUUID(),
      checksum,
      MIGRATION,
      startedAt,
    );
  });

  const [{ count }]: { count: bigint }[] = await prisma.$queryRawUnsafe(
    'SELECT count(*)::bigint AS count FROM employee_reporting_lines',
  );
  console.log(`\nApplied. employee_reporting_lines is in place with ${count} rows.`);
  console.log('Check with: npx prisma migrate status   (should say "Database schema is up to date!")');
}

main()
  .catch((err) => {
    console.error('\nFailed. Nothing was applied (the transaction rolled back).');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
