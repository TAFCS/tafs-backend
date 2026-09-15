import { StaffRole } from '@prisma/client';
import {
  ALL_ACTIONS_WILDCARD,
  actionKey,
  actionsCover,
  compactActionKeys,
  TILES_MANIFEST,
} from './tiles.manifest';
import { computeEffectiveAccess, type EffectiveTile } from './access.effective';

const tilesWithActions = TILES_MANIFEST.filter((t) => (t.actions ?? []).length > 1);
const allOf = (tileId: string) => {
  const tile = TILES_MANIFEST.find((t) => t.id === tileId)!;
  return (tile.actions ?? []).map((a) => actionKey(tileId, a.id));
};

describe('action claim compaction', () => {
  it('collapses a tile the user holds in full to tile#*', () => {
    for (const tile of tilesWithActions) {
      expect(compactActionKeys(allOf(tile.id))).toEqual([
        actionKey(tile.id, ALL_ACTIONS_WILDCARD),
      ]);
    }
  });

  it('leaves a partial hold expanded', () => {
    const partial = allOf('finance.student_overrides').slice(0, 3);
    expect(compactActionKeys(partial)).toEqual(partial);
  });

  it('is lossless — every action answers the same before and after', () => {
    for (const tile of tilesWithActions) {
      for (const subset of [allOf(tile.id), allOf(tile.id).slice(0, 2)]) {
        const compacted = new Set(compactActionKeys(subset));
        const expanded = new Set(subset);
        for (const action of allOf(tile.id)) {
          expect(actionsCover(compacted, action)).toBe(expanded.has(action));
        }
      }
    }
  });

  it('passes through keys it does not recognise rather than dropping them', () => {
    // Never be the thing that revokes access.
    expect(compactActionKeys(['not.a.tile#whatever', 'malformed'])).toEqual([
      'not.a.tile#whatever',
      'malformed',
    ]);
  });

  it('keeps the compacted claim well under the 4KB cookie limit', () => {
    // The reason this exists: the expanded claim for a fully-privileged
    // non-super user was ~1.9KB on its own and pushed the token over 4096.
    const everything = TILES_MANIFEST.flatMap((t) =>
      (t.actions ?? []).map((a) => actionKey(t.id, a.id)),
    );
    const expandedBytes = JSON.stringify(everything).length;
    const compactBytes = JSON.stringify(compactActionKeys(everything)).length;
    expect(compactBytes).toBeLessThan(expandedBytes / 2);
  });

  it('compacts exactly what the legacy bridge grants', () => {
    const tile: EffectiveTile = {
      id: 'finance.student_overrides',
      capabilities: ['fee_admin.studentwise_schedule.view'],
      actions: (TILES_MANIFEST.find((t) => t.id === 'finance.student_overrides')!.actions ?? []).map(
        (a) => ({ id: a.id, default: a.default ?? false, implies: a.implies ?? [] }),
      ),
      legacyFullAccessCapabilities: ['fee_admin.studentwise_schedule.edit'],
    };
    const { actionIds } = computeEffectiveAccess({
      role: StaffRole.EMPLOYEE,
      allPermissionKeys: [],
      activeTiles: [tile],
      roleKeys: ['fee_admin.studentwise_schedule.view', 'fee_admin.studentwise_schedule.edit'],
      packTileIds: [],
      allowTileIds: [],
      denyTileIds: [],
      userPerms: [],
    });
    expect(compactActionKeys(actionIds)).toEqual(['finance.student_overrides#*']);
    expect(actionsCover(compactActionKeys(actionIds), 'finance.student_overrides#reset')).toBe(true);
  });
});
