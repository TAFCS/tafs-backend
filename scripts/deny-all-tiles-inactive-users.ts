/**
 * TAFSD-284 — inactive logins get every tile denied, Staff App tabs included.
 * (Web tiles are already covered by deny-web-tiles-except-admins.ts.)
 * SUPER_ADMIN is skipped: a deny has no effect on it.
 *   npx ts-node --transpile-only scripts/deny-all-tiles-inactive-users.ts [--apply]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const GRANTED_BY = process.env.GRANTED_BY ?? '';

async function main() {
  if (APPLY && !GRANTED_BY) throw new Error('GRANTED_BY (user id) is required with --apply');
  const tiles = await prisma.access_tiles.findMany({ where: { is_active: true }, select: { id: true } });
  const users = await prisma.users.findMany({
    where: { is_active: false, deleted_at: null, role: { not: 'SUPER_ADMIN' } },
    select: { id: true, username: true, user_tile_grants: { where: { allow: false }, select: { tile_id: true } } },
  });
  let rows = 0;
  const pairs = users.flatMap((u) => {
    const denied = new Set(u.user_tile_grants.map((g) => g.tile_id));
    return tiles.filter((t) => !denied.has(t.id)).map((t) => ({ user_id: u.id, tile_id: t.id }));
  });
  rows = pairs.length;
  if (APPLY && pairs.length > 0) {
    const note = 'TAFSD-284 inactive: all tiles off';
    const userIds = users.map((u) => u.id);
    await prisma.user_tile_grants.updateMany({
      where: { user_id: { in: userIds }, allow: true },
      data: { allow: false, granted_by: GRANTED_BY, granted_at: new Date(), note },
    });
    const data = pairs.map((p) => ({ ...p, allow: false, granted_by: GRANTED_BY, note }));
    for (let i = 0; i < data.length; i += 2000) {
      await prisma.user_tile_grants.createMany({ data: data.slice(i, i + 2000), skipDuplicates: true });
    }
  }
  console.log(`inactive non-super-admin users: ${users.length}; deny rows ${APPLY ? 'written' : 'to write'}: ${rows}`);
}

main().finally(() => prisma.$disconnect());
