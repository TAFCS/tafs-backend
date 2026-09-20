import 'reflect-metadata';
import { StaffRole } from '@prisma/client';
import { SaturdaySchedulesController } from '../hr/saturday-schedules/saturday-schedules.controller';
import { ShiftOverridesController } from '../hr/shift-overrides/shift-overrides.controller';
import { CalendarController } from '../hr/calendar/calendar.controller';
import { PoliciesController } from '../hr/policies/policies.controller';
import { ClassAttendanceModesController } from '../hr/class-attendance-modes/class-attendance-modes.controller';
import { SaturdaySchedulesService } from '../hr/saturday-schedules/saturday-schedules.service';
import { ShiftOverridesService } from '../hr/shift-overrides/shift-overrides.service';
import { ForbiddenException } from '@nestjs/common';
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

describe('Policy tiles (Saturday Schedules, Shift Overrides, Calendar, Settings, Class Modes)', () => {
  const TILES = [
    'attendance.saturday_schedules',
    'attendance.shift_overrides',
    'attendance.academic_calendar',
    'attendance.settings',
    'attendance.class_modes',
  ];

  it.each(TILES.filter((t) => t !== 'attendance.academic_calendar'))('%s bridges from hr.policies.manage and has one default action', (id) => {
    const t = tile(id);
    expect(t.legacyFullAccessCapabilities).toEqual(['hr.policies.manage']);
    expect(t.actions!.filter((a) => a.default).map((a) => a.id)).toEqual(['view']);
    const holder = computeEffectiveAccess({ ...base, role: StaffRole.CAMPUS_ADMIN, roleKeys: ['hr.policies.manage'] });
    for (const a of t.actions!) expect(holder.actionIds).toContain(actionKey(id, a.id));
    const other = computeEffectiveAccess({ ...base, role: StaffRole.EMPLOYEE, roleKeys: ['hr.leave.apply'] });
    expect(other.tileIds).not.toContain(id);
  });

  // Regression: these two controllers had only JwtStaffGuard, i.e. no permission
  // check at all.
  it.each([
    ['SaturdaySchedulesController', SaturdaySchedulesController],
    ['ShiftOverridesController', ShiftOverridesController],
  ])('%s is action-gated, not just authenticated', (_n, ctrl) => {
    const guards: unknown[] = Reflect.getMetadata('__guards__', ctrl) ?? [];
    expect(guards).toContain(TileActionGuard);
    assertEveryRouteAccountedFor(ctrl as any, {});
  });

  it('Saturday Schedules: view by default, create and remove on manage', () => {
    expect(meta(SaturdaySchedulesController)?.actionKeys).toEqual([actionKey('attendance.saturday_schedules', 'view')]);
    for (const h of ['create', 'remove']) {
      expect(meta(SaturdaySchedulesController.prototype, h)?.actionKeys).toEqual([
        actionKey('attendance.saturday_schedules', 'manage'),
      ]);
    }
  });

  it('Shift Overrides routes accept either the tile or the Employee Directory tab that shares the panel', () => {
    const p = ShiftOverridesController.prototype;
    expect(meta(p, 'list')?.actionKeys).toEqual(['attendance.shift_overrides#view', 'hr.employee_directory#shift_overrides.view']);
    for (const h of ['bulkCreate', 'remove']) {
      expect(meta(p, h)?.mode).toBe('any');
      expect(meta(p, h)?.actionKeys).toEqual(['attendance.shift_overrides#manage', 'hr.employee_directory#shift_overrides.edit']);
    }
    keysExist(meta(p, 'list')!.actionKeys.concat(meta(p, 'bulkCreate')!.actionKeys));
  });

  // Every calendar write was locked to SUPER_ADMIN by a raw role check. Bridging
  // would have handed them to every hr.policies.manage holder.
  it('Calendar has NO bridge: a CAMPUS_ADMIN with hr.policies.manage holds the tile but not `manage`', () => {
    const t = tile('attendance.academic_calendar');
    expect(t.legacyFullAccessCapabilities).toBeUndefined();
    const campusAdmin = computeEffectiveAccess({ ...base, role: StaffRole.CAMPUS_ADMIN, roleKeys: ['hr.policies.manage'] });
    expect(campusAdmin.tileIds).toContain('attendance.academic_calendar');
    expect(campusAdmin.actionIds.filter((k) => k.startsWith('attendance.academic_calendar#'))).toEqual([
      actionKey('attendance.academic_calendar', 'view'),
    ]);
    const sa = computeEffectiveAccess({ ...base, role: StaffRole.SUPER_ADMIN });
    expect(sa.actionIds).toContain(actionKey('attendance.academic_calendar', 'manage'));
    const delegated = computeEffectiveAccess({
      ...base,
      role: StaffRole.CAMPUS_ADMIN,
      roleKeys: ['hr.policies.manage'],
      userActionGrants: [{ tileId: 'attendance.academic_calendar', actionId: 'manage', allow: true }],
    });
    expect(delegated.actionIds).toContain(actionKey('attendance.academic_calendar', 'manage'));
  });

  it('Calendar no longer hard-codes a SUPER_ADMIN check in the controller', () => {
    expect((CalendarController.prototype as any).assertSuperAdmin).toBeUndefined();
  });

  it('Calendar: page-only routes take its own actions; only the list is shared', () => {
    const p = CalendarController.prototype;
    for (const h of ['syncAttendance', 'createBulk', 'create', 'update']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('attendance.academic_calendar', 'manage')]);
    }
    for (const h of ['listNotificationReports', 'findOne']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('attendance.academic_calendar', 'view')]);
    }
    expect(meta(p, 'findAll')?.actionKeys).toEqual(
      expect.arrayContaining([
        'attendance.academic_calendar#view',
        'attendance.shift_overrides#view',
        'hr.employee_directory#shift_overrides.view',
      ]),
    );
    // bulk-employees and delete are ALSO called by the shared panel, but were
    // SUPER_ADMIN-only, so they accept ONLY the calendar's own `manage`.
    for (const h of ['createForEmployees', 'remove']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('attendance.academic_calendar', 'manage')]);
    }
    assertEveryRouteAccountedFor(CalendarController, {});
    keysExist(['findAll', 'createForEmployees', 'remove'].flatMap((h) => meta(p, h)!.actionKeys));
  });

  it('Settings: reads on view, sets and rules on their own actions', () => {
    const p = PoliciesController.prototype;
    for (const h of ['findAll', 'findOneSet']) expect(meta(p, h)?.actionKeys).toEqual(['attendance.settings#view']);
    for (const h of ['createSet', 'updateSet', 'removeSet']) expect(meta(p, h)?.actionKeys).toEqual(['attendance.settings#sets.manage']);
    for (const h of ['createRule', 'updateRule', 'removeRule']) expect(meta(p, h)?.actionKeys).toEqual(['attendance.settings#rules.manage']);
    assertEveryRouteAccountedFor(PoliciesController, {});
    keysExist(['attendance.settings#view', 'attendance.settings#sets.manage', 'attendance.settings#rules.manage']);
  });

  it('Class Modes: reads on view, set and clear on manage', () => {
    const p = ClassAttendanceModesController.prototype;
    for (const h of ['findAll', 'findOne']) expect(meta(p, h)?.actionKeys).toEqual(['attendance.class_modes#view']);
    for (const h of ['setMode', 'remove']) expect(meta(p, h)?.actionKeys).toEqual(['attendance.class_modes#manage']);
    assertEveryRouteAccountedFor(ClassAttendanceModesController, {});
  });
});

describe('Delegation past the services\' role checks (Saturday Schedules, Shift Overrides)', () => {
  // Built without running the constructor: only the role/action check is under test.
  const saturday = Object.create(SaturdaySchedulesService.prototype) as any;
  const shift = Object.create(ShiftOverridesService.prototype) as any;
  const user = (role: string, actions?: string[]) => ({ sub: 'u', role, campusId: null, actions }) as any;

  it('keeps SUPER_ADMIN and CAMPUS_ADMIN exactly as they were, with or without an actions claim', () => {
    for (const role of ['SUPER_ADMIN', 'CAMPUS_ADMIN']) {
      expect(() => saturday.assertCanManage(user(role), 'manage')).not.toThrow();
      expect(() => saturday.assertCanManage(user(role), 'view')).not.toThrow();
      expect(() => shift.assertCanManage(user(role))).not.toThrow();
      expect(() => saturday.assertCanManage(user(role, []), 'manage')).not.toThrow();
    }
  });

  it('still refuses any other role that holds no action, including an old session with no actions claim', () => {
    for (const role of ['PRINCIPAL', 'FINANCE_CLERK', 'TEACHER', 'EMPLOYEE']) {
      expect(() => saturday.assertCanManage(user(role), 'manage')).toThrow(ForbiddenException);
      expect(() => saturday.assertCanManage(user(role, []), 'view')).toThrow(ForbiddenException);
      expect(() => shift.assertCanManage(user(role, []))).toThrow(ForbiddenException);
    }
  });

  it('lets a user a SUPER_ADMIN delegated to pass, and only for what was delegated', () => {
    const viewer = user('PRINCIPAL', ['attendance.saturday_schedules#view']);
    expect(() => saturday.assertCanManage(viewer, 'view')).not.toThrow();
    expect(() => saturday.assertCanManage(viewer, 'manage')).toThrow(ForbiddenException);
    const manager = user('PRINCIPAL', ['attendance.saturday_schedules#manage']);
    expect(() => saturday.assertCanManage(manager, 'manage')).not.toThrow();
    expect(() => shift.assertCanManage(user('PRINCIPAL', ['attendance.shift_overrides#manage']))).not.toThrow();
    // another tile's action does not open this one
    expect(() => shift.assertCanManage(user('PRINCIPAL', ['attendance.saturday_schedules#manage']))).toThrow(ForbiddenException);
    // a whole-tile wildcard claim covers it
    expect(() => shift.assertCanManage(user('PRINCIPAL', ['attendance.shift_overrides#*']))).not.toThrow();
  });
});
