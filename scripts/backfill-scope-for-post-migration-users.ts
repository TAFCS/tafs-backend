/**
 * Give users created AFTER the 2026-09-12 scope backfill the scope rows they
 * never got.
 *
 * Why: dashboard access is now decided by user_scope_entries alone —
 * users.campus_id / allowed_class_ids say where someone works (payroll, the
 * staff app), not what they may see. Migration 20260912120000 copied those
 * columns into scope rows for everyone who existed then, but user creation
 * still writes only the columns. Such a user was held to their home campus by
 * the old checks; with scope as the only source they would see every campus.
 * This writes their current restriction down as explicit scope, so nothing
 * widens. Admins can then widen it in People & Access.
 *
 * Only users created on/after the migration are considered: an older user with
 * no CAMPUS rows had them deliberately cleared to "All" in People & Access,
 * and must not be re-restricted.
 *
 * Dry run by default. Writes only with --apply.
 *   npx ts-node scripts/backfill-scope-for-post-migration-users.ts
 *   npx ts-node scripts/backfill-scope-for-post-migration-users.ts --apply
 */
import { PrismaClient, ScopeDimension, StaffRole } from '@prisma/client';

const prisma = new PrismaClient();
const MIGRATED_AT = new Date('2026-09-12T00:00:00Z');
const APPLY = process.argv.includes('--apply');

async function main() {
  const users = await prisma.users.findMany({
    where: {
      created_at: { gte: MIGRATED_AT },
      role: { not: StaffRole.SUPER_ADMIN },
      deleted_at: null,
      OR: [{ campus_id: { not: null } }, { allowed_class_ids: { isEmpty: false } }],
    },
    select: {
      id: true,
      username: true,
      created_at: true,
      campus_id: true,
      allowed_class_ids: true,
      user_scope_entries: { select: { dimension: true } },
    },
    orderBy: { created_at: 'asc' },
  });

  const rows: { user_id: string; dimension: ScopeDimension; ref_id: number }[] = [];
  for (const u of users) {
    const has = new Set(u.user_scope_entries.map((e) => e.dimension));
    const add: string[] = [];
    if (u.campus_id != null && !has.has(ScopeDimension.CAMPUS)) {
      rows.push({ user_id: u.id, dimension: ScopeDimension.CAMPUS, ref_id: u.campus_id });
      add.push(`campus ${u.campus_id}`);
    }
    if (u.allowed_class_ids.length > 0 && !has.has(ScopeDimension.CLASS)) {
      for (const c of u.allowed_class_ids) rows.push({ user_id: u.id, dimension: ScopeDimension.CLASS, ref_id: c });
      add.push(`classes ${u.allowed_class_ids.join(',')}`);
    }
    if (add.length) console.log(`${u.username.padEnd(28)} created ${u.created_at.toISOString().slice(0, 10)}  + ${add.join('; ')}`);
  }

  console.log(`\n${rows.length} scope row(s) for ${new Set(rows.map((r) => r.user_id)).size} user(s).`);
  if (!APPLY) {
    console.log('Dry run — nothing written. Re-run with --apply to write.');
    return;
  }
  const { count } = await prisma.user_scope_entries.createMany({ data: rows, skipDuplicates: true });
  console.log(`Inserted ${count} row(s). Affected users pick it up on their next page load.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
