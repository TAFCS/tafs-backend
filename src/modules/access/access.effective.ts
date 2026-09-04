import { StaffRole } from '@prisma/client';

export type EffectiveTile = { id: string; capabilities: string[] };

function capsForTiles(tileIds: Iterable<string>, tilesById: Map<string, EffectiveTile>): Set<string> {
  const keys = new Set<string>();
  for (const id of tileIds) {
    const tile = tilesById.get(id);
    if (!tile) continue;
    for (const c of tile.capabilities) keys.add(c);
  }
  return keys;
}

export function computeEffectiveAccess(args: {
  role: StaffRole;
  allPermissionKeys: string[];
  activeTiles: EffectiveTile[];
  roleKeys: string[];
  packTileIds: string[];
  allowTileIds: string[];
  denyTileIds: string[];
  userPerms: { key: string; granted: boolean }[];
}): { capabilityKeys: string[]; tileIds: string[] } {
  const {
    role,
    allPermissionKeys,
    activeTiles,
    roleKeys,
    packTileIds,
    allowTileIds,
    denyTileIds,
    userPerms,
  } = args;

  if (role === StaffRole.SUPER_ADMIN) {
    return {
      capabilityKeys: [...allPermissionKeys],
      tileIds: activeTiles.map((t) => t.id),
    };
  }

  const tilesById = new Map(activeTiles.map((t) => [t.id, t]));
  const denied = new Set(denyTileIds);
  const remainingPack = packTileIds.filter((id) => !denied.has(id));

  const union = new Set<string>(roleKeys);
  for (const k of capsForTiles(packTileIds, tilesById)) union.add(k);
  for (const k of capsForTiles(allowTileIds, tilesById)) union.add(k);

  const stillGranted = new Set<string>(roleKeys);
  for (const k of capsForTiles(remainingPack, tilesById)) stillGranted.add(k);
  for (const k of capsForTiles(allowTileIds, tilesById)) stillGranted.add(k);

  for (const k of capsForTiles(denyTileIds, tilesById)) {
    if (!stillGranted.has(k)) union.delete(k);
  }

  for (const up of userPerms) {
    if (up.granted) union.add(up.key);
    else union.delete(up.key);
  }

  const capabilityKeys = [...union];
  const keySet = new Set(capabilityKeys);
  const tileIds = activeTiles
    .filter((t) => !denied.has(t.id) && t.capabilities.every((c) => keySet.has(c)))
    .map((t) => t.id);

  return { capabilityKeys, tileIds };
}
