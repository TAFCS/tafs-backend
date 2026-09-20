import 'reflect-metadata';
import { StaffRole } from '@prisma/client';
import { TimetablesController } from '../timetables/timetables.controller';
import { SubjectsController } from '../timetables/subjects.controller';
import { TeachingGroupsController } from '../timetables/teaching-groups.controller';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { TILES_MANIFEST, actionKey } from './tiles.manifest';
import { computeEffectiveAccess, type EffectiveTile } from './access.effective';
import {
  REQUIRE_ACTION_KEY,
  type RequireActionMetadata,
} from '../../decorators/require-action.decorator';

const tile = (id: string) => TILES_MANIFEST.find((t) => t.id === id)!;

const effectiveTiles: EffectiveTile[] = TILES_MANIFEST.map((t) => ({
  id: t.id,
  capabilities: t.capabilities,
  actions: t.actions?.map((a) => ({ id: a.id, default: !!a.default, implies: a.implies ?? [] })),
  legacyFullAccessCapabilities: t.legacyFullAccessCapabilities,
}));
const base = {
  allPermissionKeys: [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))],
  activeTiles: effectiveTiles,
  packTileIds: [] as string[],
  allowTileIds: [] as string[],
  denyTileIds: [] as string[],
  userPerms: [] as { key: string; granted: boolean }[],
};

function meta(target: object, handler?: string): RequireActionMetadata | undefined {
  return Reflect.getMetadata(REQUIRE_ACTION_KEY, handler ? (target as any)[handler] : (target as any));
}

function handlersOf(controller: new (...args: any[]) => unknown): string[] {
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto).filter(
    (n) => n !== 'constructor' && typeof proto[n] === 'function',
  );
}

function keysExist(keys: string[]) {
  for (const key of keys) {
    const [tileId, actionId] = key.split('#');
    expect({ key, ok: !!tile(tileId)?.actions?.some((a) => a.id === actionId) }).toEqual({ key, ok: true });
  }
}

/**
 * A route with no @RequireAction is ungated. Every handler must either carry an
 * action (its own or its class's) or be listed here BY DESIGN with a reason, so
 * adding a route without deciding fails this instead of shipping open.
 */
function assertEveryRouteAccountedFor(
  controller: new (...args: any[]) => unknown,
  undecoratedByDesign: Record<string, string>,
) {
  const classMeta = meta(controller);
  for (const h of handlersOf(controller)) {
    const has = !!meta(controller.prototype, h) || !!classMeta;
    if (undecoratedByDesign[h]) {
      expect({ h, decorated: has }).toEqual({ h, decorated: false });
    } else {
      expect({ h, decorated: has }).toEqual({ h, decorated: true });
    }
  }
}

describe('Timetables', () => {
  const t = tile('attendance.timetables');

  it('bridges from hr.timetable.manage, which the tile itself already requires', () => {
    expect(t.capabilities).toEqual(['hr.timetable.view', 'hr.timetable.manage']);
    expect(t.legacyFullAccessCapabilities).toEqual(['hr.timetable.manage']);
    const r = computeEffectiveAccess({
      ...base,
      role: StaffRole.CAMPUS_ADMIN,
      roleKeys: ['hr.timetable.view', 'hr.timetable.manage'],
    });
    for (const a of t.actions!) expect(r.actionIds).toContain(actionKey('attendance.timetables', a.id));
  });

  it('gates the page routes on their own actions and keeps getOrCreate under view', () => {
    const p = TimetablesController.prototype;
    for (const h of ['listPeriods', 'getGrid', 'getGridByGroup', 'getOrCreate', 'getOrCreateByGroup']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('attendance.timetables', 'view')]);
    }
    for (const h of ['upsertPeriod', 'deletePeriod']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('attendance.timetables', 'periods.manage')]);
    }
    for (const h of ['upsertSlot', 'deleteSlot']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('attendance.timetables', 'slots.manage')]);
    }
    const guards: unknown[] = Reflect.getMetadata('__guards__', TimetablesController) ?? [];
    expect(guards).toContain(TileActionGuard);
    keysExist(['attendance.timetables#view', 'attendance.timetables#periods.manage', 'attendance.timetables#slots.manage']);
  });

  it('accounts for every route: decorated, or left open on purpose with a reason', () => {
    assertEveryRouteAccountedFor(TimetablesController, {
      listBlocks: 'no webapp caller; policy check only',
      getDaySlots: 'no webapp caller; policy check only',
      getDaySlotsByGroup: 'also read by the A-Level Roll Call page (hr/roll-call)',
      listTeacherSlots: 'no webapp caller; policy check only',
      getExpectedTimes: 'no webapp caller; policy check only',
    });
  });

  it('puts subject writes on the slot editor action and leaves the shared list open', () => {
    const p = SubjectsController.prototype;
    for (const h of ['create', 'update', 'remove']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('attendance.timetables', 'slots.manage')]);
    }
    assertEveryRouteAccountedFor(SubjectsController, { list: 'read by both Timetables and Teaching Groups' });
  });
});

describe('Teaching Groups', () => {
  const t = tile('attendance.teaching_groups');

  it('bridges from hr.timetable.manage', () => {
    expect(t.legacyFullAccessCapabilities).toEqual(['hr.timetable.manage']);
    expect(t.actions!.filter((a) => a.default).map((a) => a.id)).toEqual(['view']);
  });

  it('defaults every route to view and puts edits and enrolment on their own actions', () => {
    expect(meta(TeachingGroupsController)?.actionKeys).toEqual([actionKey('attendance.teaching_groups', 'view')]);
    const p = TeachingGroupsController.prototype;
    for (const h of ['create', 'update', 'remove']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('attendance.teaching_groups', 'manage')]);
    }
    for (const h of ['bulkEnroll', 'removeEnrollment']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('attendance.teaching_groups', 'enroll')]);
    }
    assertEveryRouteAccountedFor(TeachingGroupsController, {});
    const guards: unknown[] = Reflect.getMetadata('__guards__', TeachingGroupsController) ?? [];
    expect(guards).toContain(TileActionGuard);
    keysExist(['attendance.teaching_groups#view', 'attendance.teaching_groups#manage', 'attendance.teaching_groups#enroll']);
  });

  it('lets a SUPER_ADMIN narrow a person: deny enrol and they keep view and manage', () => {
    const r = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      roleKeys: ['hr.timetable.view', 'hr.timetable.manage'],
      userActionGrants: [{ tileId: 'attendance.teaching_groups', actionId: 'enroll', allow: false }],
    });
    expect(r.actionIds).toContain(actionKey('attendance.teaching_groups', 'view'));
    expect(r.actionIds).toContain(actionKey('attendance.teaching_groups', 'manage'));
    expect(r.actionIds).not.toContain(actionKey('attendance.teaching_groups', 'enroll'));
  });
});
