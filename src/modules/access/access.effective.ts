import { StaffRole } from '@prisma/client';

export type EffectiveTileAction = {
  id: string;
  default: boolean;
  implies: string[];
};

export type EffectiveTile = {
  id: string;
  capabilities: string[];
  actions?: EffectiveTileAction[];
  /** Holding any of these capability keys confers every action of this tile. */
  legacyFullAccessCapabilities?: string[];
};

export type ActionRef = { tileId: string; actionId: string };

/** Global address of a sub-permission, matching tiles.manifest's actionKey(). */
const key = (tileId: string, actionId: string) => `${tileId}#${actionId}`;

function capsForTiles(tileIds: Iterable<string>, tilesById: Map<string, EffectiveTile>): Set<string> {
  const keys = new Set<string>();
  for (const id of tileIds) {
    const tile = tilesById.get(id);
    if (!tile) continue;
    for (const c of tile.capabilities) keys.add(c);
  }
  return keys;
}

/**
 * Walks `implies` edges from `seed` within one tile, returning every action id
 * reachable. Cycles terminate because ids are only ever visited once.
 */
function expandImplies(
  tile: EffectiveTile,
  seed: Iterable<string>,
  reverse = false,
): Set<string> {
  const byId = new Map((tile.actions ?? []).map((a) => [a.id, a]));
  const edges = new Map<string, string[]>();

  for (const action of tile.actions ?? []) {
    if (reverse) {
      // "who implies me" — used so denying an action also denies anything
      // that would have conferred it.
      for (const target of action.implies) {
        edges.set(target, [...(edges.get(target) ?? []), action.id]);
      }
    } else {
      edges.set(action.id, [...action.implies]);
    }
  }

  const out = new Set<string>();
  const stack = [...seed];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id) || !byId.has(id)) continue;
    out.add(id);
    for (const next of edges.get(id) ?? []) stack.push(next);
  }
  return out;
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
  /** Sub-permissions carried by the user's assigned access packs. */
  packActions?: ActionRef[];
  /** Per-user sub-permission overrides. allow=false beats every grant. */
  userActionGrants?: (ActionRef & { allow: boolean })[];
}): { capabilityKeys: string[]; tileIds: string[]; actionIds: string[] } {
  const {
    role,
    allPermissionKeys,
    activeTiles,
    roleKeys,
    packTileIds,
    allowTileIds,
    denyTileIds,
    userPerms,
    packActions = [],
    userActionGrants = [],
  } = args;

  if (role === StaffRole.SUPER_ADMIN) {
    return {
      capabilityKeys: [...allPermissionKeys],
      tileIds: activeTiles.map((t) => t.id),
      actionIds: activeTiles.flatMap((t) => (t.actions ?? []).map((a) => key(t.id, a.id))),
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
  const effectiveTiles = activeTiles.filter(
    (t) => !denied.has(t.id) && t.capabilities.every((c) => keySet.has(c)),
  );
  const tileIds = effectiveTiles.map((t) => t.id);

  // ── Sub-permissions ──────────────────────────────────────────────────────
  //
  // Actions only resolve for tiles the user actually holds: granting an action
  // on a tile they cannot open is meaningless, and a denied tile takes its
  // actions with it.
  const packActionsByTile = new Map<string, string[]>();
  for (const a of packActions) {
    packActionsByTile.set(a.tileId, [...(packActionsByTile.get(a.tileId) ?? []), a.actionId]);
  }
  const userAllowByTile = new Map<string, string[]>();
  const userDenyByTile = new Map<string, string[]>();
  for (const g of userActionGrants) {
    const bucket = g.allow ? userAllowByTile : userDenyByTile;
    bucket.set(g.tileId, [...(bucket.get(g.tileId) ?? []), g.actionId]);
  }

  const actionIds: string[] = [];
  for (const tile of effectiveTiles) {
    if (!tile.actions || tile.actions.length === 0) continue;

    const holdsLegacyFullAccess = (tile.legacyFullAccessCapabilities ?? []).some((c) =>
      keySet.has(c),
    );

    const seed = holdsLegacyFullAccess
      ? tile.actions.map((a) => a.id)
      : [
          ...tile.actions.filter((a) => a.default).map((a) => a.id),
          ...(packActionsByTile.get(tile.id) ?? []),
          ...(userAllowByTile.get(tile.id) ?? []),
        ];

    const granted = expandImplies(tile, seed);

    // A denial removes the action AND anything that would have conferred it,
    // so denying "view profile" cannot leave "edit profile" standing.
    const deniedSeed = userDenyByTile.get(tile.id) ?? [];
    const deniedSet = expandImplies(tile, deniedSeed, true);

    for (const id of granted) {
      if (!deniedSet.has(id)) actionIds.push(key(tile.id, id));
    }
  }

  return { capabilityKeys, tileIds, actionIds };
}
