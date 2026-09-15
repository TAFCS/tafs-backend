import 'reflect-metadata';
import { StudentFeesController } from './student-fees.controller';
import { InstallmentsController } from '../installments/installments.controller';
import { TILES_MANIFEST } from '../access/tiles.manifest';
import {
  REQUIRE_ACTION_KEY,
  type RequireActionMetadata,
} from '../../decorators/require-action.decorator';

const TILE_ID = 'finance.student_overrides';

const tile = TILES_MANIFEST.find((t) => t.id === TILE_ID)!;
const actionIds = new Set((tile.actions ?? []).map((a) => a.id));

/**
 * Routes deliberately left on their CASL check alone.
 *
 * `by-student/:ccNumber` is also read by the Single Voucher Issuance page
 * (tile `finance.single_voucher`); pinning it to this tile's `view` would 403
 * every voucher clerk who does not also hold Student Overrides.
 */
const UNDECORATED_BY_DESIGN = new Set(['findByStudentCC']);

function handlersOf(controller: new (...args: any[]) => unknown): string[] {
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto).filter(
    (name) => name !== 'constructor' && typeof proto[name] === 'function',
  );
}

function requiredActions(controller: new (...args: any[]) => unknown, handler: string): string[] {
  const meta: RequireActionMetadata | undefined = Reflect.getMetadata(
    REQUIRE_ACTION_KEY,
    (controller.prototype as any)[handler],
  );
  return meta?.actionKeys ?? [];
}

describe('Student Overrides sub-permissions', () => {
  it('declares exactly one default action and a legacy bridge', () => {
    expect(tile.actions?.length).toBeGreaterThan(0);
    expect(tile.actions!.filter((a) => a.default)).toHaveLength(1);
    expect(tile.actions!.find((a) => a.default)!.id).toBe('view');
    // Without the bridge, every role holding blanket edit rights silently
    // loses them the day actions ship.
    expect(tile.legacyFullAccessCapabilities).toEqual(['fee_admin.studentwise_schedule.edit']);
  });

  it('has unique action ids and only implies actions that exist', () => {
    const ids = (tile.actions ?? []).map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of tile.actions ?? []) {
      for (const implied of action.implies ?? []) {
        expect(actionIds.has(implied)).toBe(true);
      }
    }
  });

  // The step people forget: a route with no @RequireAction is ungated, and the
  // UI hiding its button is not a boundary. Add a route without decorating it
  // and this fails rather than shipping.
  it.each([
    ['StudentFeesController', StudentFeesController],
    ['InstallmentsController', InstallmentsController],
  ])('decorates every route on %s', (_label, controller) => {
    for (const handler of handlersOf(controller as any)) {
      if (UNDECORATED_BY_DESIGN.has(handler)) continue;
      const keys = requiredActions(controller as any, handler);
      expect({ handler, keys }).toEqual({ handler, keys: expect.arrayContaining([expect.any(String)]) });
      for (const key of keys) {
        const [tileId, actionId] = key.split('#');
        expect(tileId).toBe(TILE_ID);
        expect(actionIds.has(actionId)).toBe(true);
      }
    }
  });

  it('keeps the danger-zone routes off the everyday actions', () => {
    expect(requiredActions(StudentFeesController, 'resetAllHeads')).toEqual([
      `${TILE_ID}#reset`,
    ]);
    expect(requiredActions(StudentFeesController, 'transferHeads')).toEqual([
      `${TILE_ID}#transfer`,
    ]);
    expect(requiredActions(StudentFeesController, 'transferPreview')).toEqual([
      `${TILE_ID}#transfer`,
    ]);
  });
});
