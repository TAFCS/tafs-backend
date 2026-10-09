/**
 * TAFSD-284 — set every WEB dashboard tile to Deny (X) for every staff login
 * except a short keep-list of admins. Staff App (mobile) tiles are left alone.
 *
 * Dry run (default): prints, for every user, the web tiles they can open today
 * (resolved with the pre-TAFSD-284 rules, i.e. role + packs + grants).
 *
 * Keep-list users who are not SUPER_ADMIN get an explicit Allow for every web
 * tile they hold today, so the new "web tiles need an explicit allow" rule does
 * not take their access away.
 *   npx ts-node --transpile-only scripts/deny-web-tiles-except-admins.ts
 * Apply:
 *   npx ts-node --transpile-only scripts/deny-web-tiles-except-admins.ts --apply
 *
 * Caveats (printed in the report too):
 * - SUPER_ADMIN short-circuits to every tile; a deny does nothing for them.
 * - A tile deny hides the tile, but a capability the ROLE baseline grants stays
 *   (see computeEffectiveAccess), so role-level API access is not removed.
 */
import { PrismaClient } from '@prisma/client';
import { computeEffectiveAccess } from '../src/modules/access/access.effective';
import { MANIFEST_EFFECTIVE_TILES, TILES_MANIFEST } from '../src/modules/access/tiles.manifest';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** usernames that keep their current access — filled from the lookup. */
const KEEP_USERNAMES = (process.env.KEEP_USERNAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const GRANTED_BY = process.env.GRANTED_BY ?? '';

async function main() {
  if (KEEP_USERNAMES.length === 0) throw new Error('KEEP_USERNAMES is required');
  if (APPLY && !GRANTED_BY) throw new Error('GRANTED_BY (user id) is required with --apply');

  const activeDbTiles = new Set(
    (await prisma.access_tiles.findMany({ where: { is_active: true }, select: { id: true } })).map((t) => t.id),
  );
  const webTiles = TILES_MANIFEST.filter((t) => t.surface !== 'staff_app' && activeDbTiles.has(t.id));
  const webTileIds = new Set(webTiles.map((t) => t.id));
  const labelOf = new Map(TILES_MANIFEST.map((t) => [t.id, `${t.module}/${t.label}`]));

  // Pre-TAFSD-284 view: role and packs still surface web tiles.
  const legacyTiles = MANIFEST_EFFECTIVE_TILES.map((t) => ({ ...t, requiresExplicitAllow: false }));

  const [allPerms, rolePerms, users] = await Promise.all([
    prisma.permissions.findMany({ select: { key: true } }),
    prisma.role_permissions.findMany({ include: { permissions: { select: { key: true } } } }),
    prisma.users.findMany({
      where: { deleted_at: null },
      select: { id: true, username: true, full_name: true, role: true, is_active: true },
      orderBy: { full_name: 'asc' },
    }),
  ]);
  const keep = new Set(KEEP_USERNAMES);
  const missing = KEEP_USERNAMES.filter((u) => !users.some((x) => x.username === u));
  if (missing.length) throw new Error(`keep-list usernames not found: ${missing.join(', ')}`);

  const roleKeys = new Map<string, string[]>();
  for (const rp of rolePerms) roleKeys.set(rp.role, [...(roleKeys.get(rp.role) ?? []), rp.permissions.key]);

  const rows: string[] = ['username,full_name,role,active,web_tile_count,web_tiles'];
  const superAdmins: string[] = [];
  let toWrite = 0;

  const keepRows: string[] = [];
  let allowsToWrite = 0;
  const denyUserIds: string[] = [];
  for (const u of users) {
    // Apply skips the per-user report reads for crossed-out users; the denies
    // are written in bulk below (one upsert per tile was ~60 writes per person).
    if (APPLY && !keep.has(u.username)) {
      denyUserIds.push(u.id);
      continue;
    }
    const [packRows, grants, userPerms] = await Promise.all([
      prisma.user_access_packs.findMany({
        where: { user_id: u.id },
        include: { pack: { include: { tiles: { select: { tile_id: true } } } } },
      }),
      prisma.user_tile_grants.findMany({ where: { user_id: u.id }, select: { tile_id: true, allow: true } }),
      prisma.user_permissions.findMany({ where: { user_id: u.id }, include: { permissions: { select: { key: true } } } }),
    ]);
    const eff = computeEffectiveAccess({
      role: u.role,
      allPermissionKeys: allPerms.map((p) => p.key),
      activeTiles: legacyTiles,
      roleKeys: roleKeys.get(u.role) ?? [],
      packTileIds: packRows.flatMap((r) => r.pack.tiles.map((t) => t.tile_id)),
      allowTileIds: grants.filter((g) => g.allow).map((g) => g.tile_id),
      denyTileIds: grants.filter((g) => !g.allow).map((g) => g.tile_id),
      userPerms: userPerms.map((up) => ({ key: up.permissions.key, granted: up.granted })),
    });
    const onWeb = eff.tileIds.filter((id) => webTileIds.has(id));

    if (keep.has(u.username)) {
      keepRows.push(`${u.full_name} (${u.username}, ${u.role}): ${u.role === 'SUPER_ADMIN' ? 'all tiles (super admin)' : `${onWeb.length} web tiles kept as explicit Allow`}`);
      if (u.role === 'SUPER_ADMIN') continue;
      const explicitAllow = new Set(grants.filter((g) => g.allow).map((g) => g.tile_id));
      const toAllow = onWeb.filter((id) => !explicitAllow.has(id));
      allowsToWrite += toAllow.length;
      if (APPLY && toAllow.length > 0) {
        await prisma.$transaction(
          toAllow.map((tile_id) =>
            prisma.user_tile_grants.upsert({
              where: { user_id_tile_id: { user_id: u.id, tile_id } },
              create: { user_id: u.id, tile_id, allow: true, granted_by: GRANTED_BY, note: 'TAFSD-284 keep current access' },
              update: { allow: true, granted_by: GRANTED_BY, granted_at: new Date(), note: 'TAFSD-284 keep current access' },
            }),
          ),
        );
      }
      continue;
    }
    if (u.role === 'SUPER_ADMIN') superAdmins.push(`${u.full_name} (${u.username})`);
    if (onWeb.length > 0) {
      rows.push(
        [u.username, JSON.stringify(u.full_name), u.role, u.is_active, onWeb.length,
          JSON.stringify(onWeb.map((id) => labelOf.get(id)).join('; '))].join(','),
      );
    }

    const alreadyDenied = new Set(grants.filter((g) => !g.allow).map((g) => g.tile_id));
    toWrite += webTiles.filter((t) => !alreadyDenied.has(t.id)).length;
  }

  if (APPLY && denyUserIds.length > 0) {
    const webIds = webTiles.map((t) => t.id);
    const note = 'TAFSD-284 bulk deny';
    const flipped = await prisma.user_tile_grants.updateMany({
      where: { user_id: { in: denyUserIds }, tile_id: { in: webIds }, allow: true },
      data: { allow: false, granted_by: GRANTED_BY, granted_at: new Date(), note },
    });
    const data = denyUserIds.flatMap((user_id) =>
      webIds.map((tile_id) => ({ user_id, tile_id, allow: false, granted_by: GRANTED_BY, note })),
    );
    let created = 0;
    for (let i = 0; i < data.length; i += 2000) {
      created += (await prisma.user_tile_grants.createMany({ data: data.slice(i, i + 2000), skipDuplicates: true })).count;
    }
    toWrite = flipped.count + created;
  }

  console.log(rows.join('\n'));
  console.log(`\nweb tiles: ${webTiles.length}; users crossed out: ${users.length - keep.size}; deny rows ${APPLY ? 'written' : 'to write'}: ${toWrite}`);
  console.log(`\nkeep-list (allow rows ${APPLY ? 'written' : 'to write'}: ${allowsToWrite}):\n  ${keepRows.join('\n  ')}`);
  console.log(`SUPER_ADMIN (deny has no effect): ${superAdmins.join(' | ') || 'none'}`);
}

main().finally(() => prisma.$disconnect());
