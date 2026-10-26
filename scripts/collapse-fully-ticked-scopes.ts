/**
 * For each user and each scope dimension, if their user_scope_entries cover
 * every current option of that dimension, delete that dimension's rows so it
 * collapses to "All".
 *
 * Why: Scopes saved before webapp 76eefae store "every option ticked" as
 * explicit id lists instead of "All". Because a restricted dimension excludes
 * records with no value on it (e.g. guards/maids/drivers have no segment),
 * those users silently lose access to staff without a value on that dimension.
 *
 * Dry run by default. Writes only with --apply.
 *   npx ts-node scripts/collapse-fully-ticked-scopes.ts
 *   npx ts-node scripts/collapse-fully-ticked-scopes.ts --apply
 */
import { PrismaClient, ScopeDimension, StaffRole } from '@prisma/client';

export interface UserScopeEntryLike {
  dimension: ScopeDimension;
  ref_id: number;
}

export function findDimensionsToCollapse(
  allOptionIds: Record<ScopeDimension, Set<number>>,
  userEntries: UserScopeEntryLike[],
): { dimension: ScopeDimension; count: number }[] {
  const entriesByDim = new Map<ScopeDimension, Set<number>>();
  for (const entry of userEntries) {
    if (!entriesByDim.has(entry.dimension)) {
      entriesByDim.set(entry.dimension, new Set());
    }
    entriesByDim.get(entry.dimension)!.add(entry.ref_id);
  }

  const result: { dimension: ScopeDimension; count: number }[] = [];
  for (const [dimKey, fullSet] of Object.entries(allOptionIds)) {
    const dimension = dimKey as ScopeDimension;
    if (fullSet.size === 0) continue;
    const userSet = entriesByDim.get(dimension);
    if (!userSet || userSet.size === 0) continue;

    const coversAll = Array.from(fullSet).every((id) => userSet.has(id));
    if (coversAll) {
      result.push({ dimension, count: userSet.size });
    }
  }
  return result;
}

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  const [campuses, segments, classes, sections, departments, staffCategories] = await Promise.all([
    prisma.campuses.findMany({ where: { is_active: true }, select: { id: true } }),
    prisma.segments.findMany({ select: { id: true } }),
    prisma.classes.findMany({ select: { id: true } }),
    prisma.sections.findMany({ select: { id: true } }),
    prisma.departments.findMany({ select: { id: true } }),
    prisma.staff_categories.findMany({ select: { id: true } }),
  ]);

  const allOptionIds: Record<ScopeDimension, Set<number>> = {
    [ScopeDimension.CAMPUS]: new Set(campuses.map((c) => c.id)),
    [ScopeDimension.SEGMENT]: new Set(segments.map((s) => s.id)),
    [ScopeDimension.CLASS]: new Set(classes.map((c) => c.id)),
    [ScopeDimension.SECTION]: new Set(sections.map((s) => s.id)),
    [ScopeDimension.DEPARTMENT]: new Set(departments.map((d) => d.id)),
    [ScopeDimension.STAFF_CATEGORY]: new Set(staffCategories.map((c) => c.id)),
  };

  const users = await prisma.users.findMany({
    where: {
      role: { not: StaffRole.SUPER_ADMIN },
      deleted_at: null,
      user_scope_entries: { some: {} },
    },
    select: {
      id: true,
      username: true,
      user_scope_entries: {
        select: { dimension: true, ref_id: true },
      },
    },
    orderBy: { username: 'asc' },
  });

  const deletions: { user_id: string; username: string; dimension: ScopeDimension; count: number }[] = [];

  for (const user of users) {
    const fullyTicked = findDimensionsToCollapse(allOptionIds, user.user_scope_entries);
    for (const item of fullyTicked) {
      deletions.push({
        user_id: user.id,
        username: user.username,
        dimension: item.dimension,
        count: item.count,
      });
      console.log(`${user.username.padEnd(28)} ${item.dimension.padEnd(16)} ${item.count} rows → All`);
    }
  }

  console.log(`\nFound ${deletions.length} dimension(s) across ${new Set(deletions.map((d) => d.user_id)).size} user(s) to collapse to "All".`);

  if (!APPLY) {
    console.log('Dry run — nothing deleted. Re-run with --apply to apply changes.');
    return;
  }

  let totalDeleted = 0;
  for (const del of deletions) {
    const res = await prisma.user_scope_entries.deleteMany({
      where: {
        user_id: del.user_id,
        dimension: del.dimension,
      },
    });
    totalDeleted += res.count;
  }

  console.log(`Deleted ${totalDeleted} user_scope_entries row(s). Affected users pick it up on their next page load.`);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
