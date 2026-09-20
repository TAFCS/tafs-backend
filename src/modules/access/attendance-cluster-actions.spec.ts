import 'reflect-metadata';
jest.mock('@react-pdf/renderer', () => ({ renderToBuffer: jest.fn() }));
jest.mock('../hr/payroll/payslip-pdf/PayslipPDF', () => ({ PayslipPDF: () => null }), { virtual: true });
import { StaffRole } from '@prisma/client';
import { SaturdaySchedulesController } from '../hr/saturday-schedules/saturday-schedules.controller';
import { ShiftOverridesController } from '../hr/shift-overrides/shift-overrides.controller';
import { CalendarController } from '../hr/calendar/calendar.controller';
import { PoliciesController } from '../hr/policies/policies.controller';
import { ClassAttendanceModesController } from '../hr/class-attendance-modes/class-attendance-modes.controller';
import { SaturdaySchedulesService } from '../hr/saturday-schedules/saturday-schedules.service';
import { ShiftOverridesService } from '../hr/shift-overrides/shift-overrides.service';
import { ForbiddenException } from '@nestjs/common';
import { StudentAttendanceController } from '../attendance/student-attendance.controller';
import { RollSessionsController } from '../attendance/roll-sessions.controller';
import { ZkAttendanceMappingController } from '../attendance/zk-attendance-mapping.controller';
import { ZkScanResolutionController } from '../attendance/zk-scan-resolution.controller';
import { ZkLogsController } from '../attendance/zk-push.controller';
import { TimetablesController } from '../timetables/timetables.controller';
import { SubjectsController } from '../timetables/subjects.controller';
import { TeachingGroupsController } from '../timetables/teaching-groups.controller';
import { StaffAttendanceController } from '../attendance/staff-attendance.controller';
import { StaffAttendanceService } from '../attendance/staff-attendance.service';
import { AttendanceObjectionsController } from '../attendance/attendance-objections.controller';
import { LeaveRequestsController } from '../hr/leaves/leave-requests.controller';
import { LeaveRequestsSelfController } from '../hr/leaves/leave-requests-self.controller';
import { PayrollMatrixController } from '../hr/payroll/payroll-matrix.controller';
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

/** Only methods that are actual routes (Nest sets `method` metadata on them), not private helpers. */
function handlersOf(controller: new (...args: any[]) => unknown): string[] {
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto).filter(
    (n) =>
      n !== 'constructor' &&
      typeof proto[n] === 'function' &&
      Reflect.getMetadata('method', proto[n]) !== undefined,
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

// ── Scope on the policy tiles, using the REAL ScopeService ────────────────────
import { NotFoundException as NF } from '@nestjs/common';
import { ScopeService } from '../../common/scope/scope.service';
import { PoliciesService } from '../hr/policies/policies.service';
import { ClassAttendanceModesService } from '../hr/class-attendance-modes/class-attendance-modes.service';
import { ClassCheckInScheduleService } from '../attendance/class-check-in-schedule.service';
import { RecomputeLateController } from '../attendance/recompute-late.controller';
import { ClassCheckInScheduleController } from '../attendance/class-check-in-schedule.controller';

describe('Scope on the policy tiles', () => {
  const realScope = new ScopeService({} as any);
  const restricted = (campuses: number[], classes: number[] = []) =>
    ({
      sub: 'u', role: 'PRINCIPAL', campusId: null, allowedClassIds: [], userType: 'STAFF', permissions: [], actions: [],
      scope: { campuses, segments: [], classes, sections: [], departments: [], staffCategories: [] },
    }) as any;
  const scoped = restricted([3]);
  const admin = { ...restricted([]), role: 'SUPER_ADMIN' } as any;
  const legacy = { ...restricted([]), campusId: 3 } as any;

  describe('Attendance Settings: policy sets and rules', () => {
    function svc(setCampus: number | null) {
      const prisma = {
        hr_policy_sets: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(setCampus == null ? null : { id: 1, campus_id: setCampus, academic_year: 'x', effective_from: new Date(), hr_policy_rules: [] }),
          create: jest.fn(), update: jest.fn(), delete: jest.fn(),
        },
        hr_policy_rules: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
      };
      return { s: new PoliciesService(prisma as any, { log: jest.fn() } as any, realScope), prisma };
    }

    it('lists only a campus the caller can act on', async () => {
      const { s } = svc(3);
      await expect(s.findAllSets(9, scoped)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(s.findAllSets(3, scoped)).resolves.toEqual([]);
      await expect(s.findAllSets(9, admin)).resolves.toEqual([]);
      await expect(s.findAllSets(9, legacy)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s a set from another campus for read, update, delete and every rule write, before any write', async () => {
      const { s, prisma } = svc(9);
      await expect(s.findOneSet(1, scoped)).rejects.toBeInstanceOf(NF);
      await expect(s.updateSet(1, {}, 'u', scoped)).rejects.toBeInstanceOf(NF);
      await expect(s.removeSet(1, 'u', scoped)).rejects.toBeInstanceOf(NF);
      await expect(s.createRule(1, { rule_type: 'x', value_json: {} } as any, 'u', scoped)).rejects.toBeInstanceOf(NF);
      await expect(s.updateRule(1, 5, {}, 'u', scoped)).rejects.toBeInstanceOf(NF);
      await expect(s.removeRule(1, 5, 'u', scoped)).rejects.toBeInstanceOf(NF);
      for (const t of [prisma.hr_policy_sets, prisma.hr_policy_rules]) {
        expect(t.create).not.toHaveBeenCalled();
        expect(t.update).not.toHaveBeenCalled();
        expect(t.delete).not.toHaveBeenCalled();
      }
      await expect(svc(null).s.findOneSet(1, scoped)).rejects.toBeInstanceOf(NF);
    });

    it('refuses creating a set for another campus, and moving one there', async () => {
      const { s, prisma } = svc(3);
      await expect(s.createSet({ campus_id: 9 } as any, 'u', scoped)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.hr_policy_sets.create).not.toHaveBeenCalled();
      await expect(s.updateSet(1, { campus_id: 9 }, 'u', scoped)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.hr_policy_sets.update).not.toHaveBeenCalled();
    });
  });

  describe('Attendance Settings: class check-in schedules', () => {
    function svc(row: unknown) {
      const prisma = {
        class_check_in_schedules: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(row), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
      };
      return { s: new ClassCheckInScheduleService(prisma as any, { log: jest.fn() } as any, realScope), prisma };
    }
    it('refuses another campus (and a class outside scope) on list and create, before any write', async () => {
      const { s, prisma } = svc(null);
      await expect(s.findAll(9, scoped)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(s.create({ campus_id: 9, class_id: 1 } as any, 'u', 'u', scoped)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(s.create({ campus_id: 3, class_id: 1 } as any, 'u', 'u', restricted([3], [7]))).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.class_check_in_schedules.create).not.toHaveBeenCalled();
    });
    it('404s a schedule from another campus on update and delete', async () => {
      const { s, prisma } = svc({ id: 1, campus_id: 9, class_id: 1, classes: null });
      await expect(s.update(1, {}, 'u', scoped)).rejects.toBeInstanceOf(NF);
      await expect(s.remove(1, 'u', scoped)).rejects.toBeInstanceOf(NF);
      expect(prisma.class_check_in_schedules.update).not.toHaveBeenCalled();
      expect(prisma.class_check_in_schedules.delete).not.toHaveBeenCalled();
    });
    it('gates the schedule routes on their own actions', () => {
      const p = ClassCheckInScheduleController.prototype;
      expect(meta(p, 'findAll')?.actionKeys).toEqual(['attendance.settings#view']);
      for (const h of ['create', 'update', 'remove']) expect(meta(p, h)?.actionKeys).toEqual(['attendance.settings#schedules.manage']);
      assertEveryRouteAccountedFor(ClassCheckInScheduleController, {});
      keysExist(['attendance.settings#schedules.manage', 'attendance.settings#recompute']);
    });
  });

  describe('Attendance Settings: recompute late status', () => {
    const mk = () => {
      const prisma = { zk_attendance_scans: { findMany: jest.fn().mockResolvedValue([]) }, attendance_student_daily: { findMany: jest.fn().mockResolvedValue([]) }, attendance_staff_daily: { findMany: jest.fn().mockResolvedValue([]) } };
      return { c: new RecomputeLateController(prisma as any, {} as any, realScope), prisma };
    };
    const dto = (campus_id: number, class_id?: number) => ({ campus_id, class_id, date_from: '2026-01-01', date_to: '2026-01-02' }) as any;

    it('is action-gated and refuses another campus before touching any attendance data', async () => {
      expect(meta(RecomputeLateController.prototype, 'recomputeLateStatus')?.actionKeys).toEqual(['attendance.settings#recompute']);
      const { c, prisma } = mk();
      await expect(c.recomputeLateStatus(dto(9), scoped)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.recomputeLateStatus(dto(9), legacy)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.recomputeLateStatus(dto(3, 5), restricted([3], [7]))).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.zk_attendance_scans.findMany).not.toHaveBeenCalled();
    });
    it('still lets the caller recompute their own campus, and a SUPER_ADMIN any campus', async () => {
      const { c } = mk();
      await expect(c.recomputeLateStatus(dto(3), scoped)).resolves.toBeDefined();
      await expect(c.recomputeLateStatus(dto(9), admin)).resolves.toBeDefined();
    });
  });

  describe('Class Modes', () => {
    function svc() {
      const prisma = {
        class_attendance_modes: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue({ class_id: 5, mode: 'X', classes: null }),
          upsert: jest.fn(), delete: jest.fn(),
        },
      };
      return { s: new ClassAttendanceModesService(prisma as any, { log: jest.fn() } as any, realScope), prisma };
    }
    it('filters the list to the caller\'s classes, and leaves an unrestricted caller alone', async () => {
      const { s, prisma } = svc();
      await s.findAll(restricted([], [7, 8]));
      expect(prisma.class_attendance_modes.findMany.mock.calls[0][0].where).toEqual({ class_id: { in: [7, 8] } });
      await s.findAll(restricted([]));
      expect(prisma.class_attendance_modes.findMany.mock.calls[1][0].where).toBeUndefined();
      await s.findAll(admin);
      expect(prisma.class_attendance_modes.findMany.mock.calls[2][0].where).toBeUndefined();
    });
    it('404s a class outside scope on read and refuses set / clear before any write', async () => {
      const { s, prisma } = svc();
      const u = restricted([], [7]);
      await expect(s.findOneByClass(5, u)).rejects.toBeInstanceOf(NF);
      await expect(s.setMode({ class_id: 5, mode: 'BIOMETRIC_DAILY' }, 'u', u)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(s.remove(5, 'u', u)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.class_attendance_modes.upsert).not.toHaveBeenCalled();
      expect(prisma.class_attendance_modes.delete).not.toHaveBeenCalled();
    });
  });

  describe('Academic Calendar', () => {
    const mk = (day: unknown = { id: 1, campus_id: 9 }, days: any[] = []) => {
      const calendarService = {
        findOne: jest.fn().mockResolvedValue(day),
        findAll: jest.fn().mockResolvedValue(days),
        create: jest.fn(), update: jest.fn(), remove: jest.fn(), createBulk: jest.fn(), createForEmployees: jest.fn(), syncAttendance: jest.fn(),
      };
      return { c: new CalendarController(calendarService as any, realScope), calendarService };
    };
    const req = (user: any) => ({ user });

    it('404s a day from another campus on read, update and delete, before any write', async () => {
      const { c, calendarService } = mk();
      await expect(c.findOne(1, req(scoped))).rejects.toBeInstanceOf(NF);
      await expect(c.update(1, {}, req(scoped))).rejects.toBeInstanceOf(NF);
      await expect(c.remove(1, req(scoped))).rejects.toBeInstanceOf(NF);
      expect(calendarService.update).not.toHaveBeenCalled();
      expect(calendarService.remove).not.toHaveBeenCalled();
    });
    it('refuses creating a day, or moving one, into another campus', async () => {
      const { c, calendarService } = mk({ id: 1, campus_id: 3 });
      await expect(c.create({ campus_id: 9 } as any, req(scoped))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.update(1, { campus_id: 9 }, req(scoped))).rejects.toBeInstanceOf(ForbiddenException);
      expect(calendarService.create).not.toHaveBeenCalled();
      expect(calendarService.update).not.toHaveBeenCalled();
    });
    it('needs an unrestricted caller for anything that reaches every campus or arbitrary employees', async () => {
      const { c, calendarService } = mk();
      await expect(c.createBulk({} as any, req(scoped))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.createForEmployees({} as any, req(scoped))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.syncAttendance({ all_campuses: true } as any, req(scoped))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.syncAttendance({ campus_id: 9 } as any, req(scoped))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.createBulk({} as any, req(legacy))).rejects.toBeInstanceOf(ForbiddenException);
      expect(calendarService.createBulk).not.toHaveBeenCalled();
      await expect(c.createBulk({} as any, req(admin))).resolves.toBeDefined();
      await expect(c.syncAttendance({ all_campuses: true } as any, req(admin))).resolves.toBeDefined();
    });
    it('returns only the caller\'s campuses when no campus is asked for, and refuses another one when it is', async () => {
      const { c } = mk({}, [{ id: 1, campus_id: 3 }, { id: 2, campus_id: 9 }, { id: 3, campus_id: null }]);
      const r: any = await c.findAll(req(scoped));
      expect(r.data.map((d: any) => d.id)).toEqual([1]);
      await expect(c.findAll(req(scoped), '9')).rejects.toBeInstanceOf(ForbiddenException);
      const all: any = await c.findAll(req(admin));
      expect(all.data).toHaveLength(3);
    });
  });

  describe('Staff Register & Employee Attendance', () => {
    const srTile = tile('attendance.staff_register');
    const eaTile = tile('attendance.employee_attendance');

    it('bridges from attendance.staff.mark for both tiles', () => {
      expect(srTile.capabilities).toEqual(['attendance.staff.mark']);
      expect(srTile.legacyFullAccessCapabilities).toEqual(['attendance.staff.mark']);
      expect(eaTile.capabilities).toEqual(['attendance.staff.mark', 'hr.objections.review']);
      expect(eaTile.legacyFullAccessCapabilities).toEqual(['attendance.staff.mark']);

      const r = computeEffectiveAccess({
        ...base,
        role: StaffRole.CAMPUS_ADMIN,
        roleKeys: ['attendance.staff.mark', 'hr.objections.review'],
      });
      for (const a of srTile.actions!) expect(r.actionIds).toContain(actionKey('attendance.staff_register', a.id));
      for (const a of eaTile.actions!) expect(r.actionIds).toContain(actionKey('attendance.employee_attendance', a.id));
    });

    it('gates routes on their respective actions', () => {
      const p = StaffAttendanceController.prototype;
      expect(meta(p, 'getRegister')?.actionKeys).toEqual([actionKey('attendance.staff_register', 'view')]);
      expect(meta(p, 'bulkMark')?.actionKeys).toEqual([
        actionKey('attendance.staff_register', 'mark'),
        actionKey('attendance.employee_attendance', 'mark'),
        actionKey('attendance.employee_attendance_cycle', 'mark'),
        actionKey('hr.payroll', 'line_manage'),
      ]);
      expect(meta(p, 'getSummary')?.actionKeys).toEqual([actionKey('attendance.employee_attendance', 'view')]);
      expect(meta(p, 'getDashboard')?.actionKeys).toEqual([actionKey('attendance.employee_attendance', 'view')]);
      expect(meta(p, 'getTimeline')?.actionKeys).toEqual([
        actionKey('attendance.employee_attendance', 'view'),
        actionKey('hr.employee_directory', 'view'),
        actionKey('attendance.timetables', 'view'),
      ]);

      const guards: unknown[] = Reflect.getMetadata('__guards__', StaffAttendanceController) ?? [];
      expect(guards).toContain(TileActionGuard);
      keysExist([
        'attendance.staff_register#view',
        'attendance.staff_register#mark',
        'attendance.employee_attendance#view',
        'attendance.employee_attendance#mark',
        'attendance.employee_attendance_cycle#mark',
      ]);
    });

    it('accounts for every route: decorated or left open on purpose with a reason', () => {
      assertEveryRouteAccountedFor(StaffAttendanceController, {
        getMyAttendance: 'staff self service with assertStaffSelfPermission',
      });
    });

    it('lets a SUPER_ADMIN narrow Employee Attendance: deny mark and they keep view', () => {
      const r = computeEffectiveAccess({
        ...base,
        role: StaffRole.EMPLOYEE,
        roleKeys: ['attendance.staff.mark', 'hr.objections.review'],
        userActionGrants: [{ tileId: 'attendance.employee_attendance', actionId: 'mark', allow: false }],
      });
      expect(r.actionIds).toContain(actionKey('attendance.employee_attendance', 'view'));
      expect(r.actionIds).not.toContain(actionKey('attendance.employee_attendance', 'mark'));
    });

    it('refuses another campus on getRegister, getSummary, getDashboard, and bulkMark before touching attendance records', async () => {
      const prisma = {
        employee_profiles: { findMany: jest.fn().mockResolvedValue([]) },
        attendance_staff_daily: { findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn(),
      };
      const holidaySync = { syncCampusForDate: jest.fn() };
      const s = new StaffAttendanceService(
        prisma as any,
        {} as any,
        holidaySync as any,
        {} as any,
        {} as any,
        { log: jest.fn() } as any,
        realScope,
      );

      await expect(
        s.getRegister({ date: '2026-09-20', campus_id: [9] } as any, scoped),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        s.getSummary({ date: '2026-09-20', campus_id: [9] } as any, scoped),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        s.getDashboard({ date: '2026-09-20', campus_id: [9] } as any, scoped),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        s.bulkMark(
          { campus_id: 9, date: '2026-09-20', records: [] } as any,
          scoped,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('Employee Attendance by Cycle', () => {
    const eacTile = tile('attendance.employee_attendance_cycle');

    it('bridges from hr.payroll.view and hr.payroll.manage', () => {
      expect(eacTile.capabilities).toEqual(['hr.payroll.view']);
      expect(eacTile.legacyFullAccessCapabilities).toEqual(['hr.payroll.manage', 'hr.payroll.view']);

      const r = computeEffectiveAccess({
        ...base,
        role: StaffRole.CAMPUS_ADMIN,
        roleKeys: ['hr.payroll.view'],
      });
      for (const a of eacTile.actions!) {
        expect(r.actionIds).toContain(actionKey('attendance.employee_attendance_cycle', a.id));
      }
    });

    it('gates matrix and export routes on their respective actions', () => {
      const p = PayrollMatrixController.prototype;
      expect(meta(p, 'getAttendanceMatrix')?.actionKeys).toEqual([
        actionKey('attendance.employee_attendance_cycle', 'view'),
        actionKey('hr.payroll', 'view'),
      ]);
      expect(meta(p, 'exportAttendanceMatrix')?.actionKeys).toEqual([
        actionKey('attendance.employee_attendance_cycle', 'export'),
        actionKey('hr.payroll', 'export'),
      ]);

      const guards: unknown[] = Reflect.getMetadata('__guards__', PayrollMatrixController) ?? [];
      expect(guards).toContain(TileActionGuard);
      keysExist([
        'attendance.employee_attendance_cycle#view',
        'attendance.employee_attendance_cycle#export',
        'attendance.employee_attendance_cycle#mark',
      ]);
    });

    it('lets a SUPER_ADMIN narrow Employee Attendance by Cycle: deny export and they keep view', () => {
      const r = computeEffectiveAccess({
        ...base,
        role: StaffRole.EMPLOYEE,
        roleKeys: ['hr.payroll.view'],
        userActionGrants: [{ tileId: 'attendance.employee_attendance_cycle', actionId: 'export', allow: false }],
      });
      expect(r.actionIds).toContain(actionKey('attendance.employee_attendance_cycle', 'view'));
      expect(r.actionIds).not.toContain(actionKey('attendance.employee_attendance_cycle', 'export'));
    });
  });

  describe('Attendance Objections', () => {
    const objTile = tile('attendance.objections');

    it('bridges from hr.objections.review', () => {
      expect(objTile.capabilities).toEqual(['hr.objections.review']);
      expect(objTile.legacyFullAccessCapabilities).toEqual(['hr.objections.review']);

      const r = computeEffectiveAccess({
        ...base,
        role: StaffRole.CAMPUS_ADMIN,
        roleKeys: ['hr.objections.review'],
      });
      for (const a of objTile.actions!) {
        expect(r.actionIds).toContain(actionKey('attendance.objections', a.id));
      }
    });

    it('gates review routes on their respective actions', () => {
      const p = AttendanceObjectionsController.prototype;
      expect(meta(p, 'listForReview')?.actionKeys).toEqual([
        actionKey('attendance.objections', 'view'),
      ]);
      expect(meta(p, 'countPending')?.actionKeys).toEqual([
        actionKey('attendance.objections', 'view'),
      ]);
      expect(meta(p, 'review')?.actionKeys).toEqual([
        actionKey('attendance.objections', 'review'),
      ]);

      const guards: unknown[] = Reflect.getMetadata('__guards__', AttendanceObjectionsController) ?? [];
      expect(guards).toContain(TileActionGuard);
      keysExist([
        'attendance.objections#view',
        'attendance.objections#review',
      ]);
    });

    it('accounts for every route: decorated or left open on purpose with a reason', () => {
      assertEveryRouteAccountedFor(AttendanceObjectionsController, {
        create: 'staff self service with assertStaffSelfPermission',
        listMine: 'staff self service with assertStaffSelfPermission',
      });
    });

    it('lets a SUPER_ADMIN narrow Attendance Objections: deny review and they keep view', () => {
      const r = computeEffectiveAccess({
        ...base,
        role: StaffRole.EMPLOYEE,
        roleKeys: ['hr.objections.review'],
        userActionGrants: [{ tileId: 'attendance.objections', actionId: 'review', allow: false }],
      });
      expect(r.actionIds).toContain(actionKey('attendance.objections', 'view'));
      expect(r.actionIds).not.toContain(actionKey('attendance.objections', 'review'));
    });
  });

  describe('Leave Requests', () => {
    const leaveTile = tile('attendance.leave_requests');

    it('bridges from hr.leave.approve', () => {
      expect(leaveTile.capabilities).toEqual(['hr.leave.approve']);
      expect(leaveTile.legacyFullAccessCapabilities).toEqual(['hr.leave.approve']);

      const r = computeEffectiveAccess({
        ...base,
        role: StaffRole.CAMPUS_ADMIN,
        roleKeys: ['hr.leave.approve'],
      });
      for (const a of leaveTile.actions!) {
        expect(r.actionIds).toContain(actionKey('attendance.leave_requests', a.id));
      }
    });

    it('gates review and revoke routes on their respective actions', () => {
      const p = LeaveRequestsController.prototype;
      expect(meta(p, 'list')?.actionKeys).toEqual([
        actionKey('attendance.leave_requests', 'view'),
      ]);
      expect(meta(p, 'getOne')?.actionKeys).toEqual([
        actionKey('attendance.leave_requests', 'view'),
      ]);
      expect(meta(p, 'review')?.actionKeys).toEqual([
        actionKey('attendance.leave_requests', 'approve'),
      ]);
      expect(meta(p, 'revoke')?.actionKeys).toEqual([
        actionKey('attendance.leave_requests', 'approve'),
      ]);

      const guards: unknown[] = Reflect.getMetadata('__guards__', LeaveRequestsController) ?? [];
      expect(guards).toContain(TileActionGuard);
      keysExist([
        'attendance.leave_requests#view',
        'attendance.leave_requests#approve',
      ]);
    });

    it('accounts for every route: decorated or left open on purpose with a reason', () => {
      assertEveryRouteAccountedFor(LeaveRequestsController, {});
      assertEveryRouteAccountedFor(LeaveRequestsSelfController, {
        create: 'staff self service with assertStaffSelfPermission',
        listMine: 'staff self service with assertStaffSelfPermission',
        getContext: 'staff self service with assertStaffSelfPermission',
        cancel: 'staff self service with assertStaffSelfPermission',
      });
    });

    it('lets a SUPER_ADMIN narrow Leave Requests: deny approve and they keep view', () => {
      const r = computeEffectiveAccess({
        ...base,
        role: StaffRole.EMPLOYEE,
        roleKeys: ['hr.leave.approve'],
        userActionGrants: [{ tileId: 'attendance.leave_requests', actionId: 'approve', allow: false }],
      });
      expect(r.actionIds).toContain(actionKey('attendance.leave_requests', 'view'));
      expect(r.actionIds).not.toContain(actionKey('attendance.leave_requests', 'approve'));
    });
  });
});


// ── Student attendance tiles, Quick Check-In, A-Level Roll Call ───────────────
describe('Student attendance tiles', () => {
  const STUDENT_TILES = [
    'attendance.student_attendance',
    'attendance.student_attendance_cycle',
    'attendance.quick_check_in',
    'attendance.alevel_roll_call',
  ];

  it.each(STUDENT_TILES)('%s bridges from rollcall.mark and has one default action', (id) => {
    const t = tile(id);
    expect(t.legacyFullAccessCapabilities).toEqual(['attendance.student.rollcall.mark']);
    expect(t.actions!.filter((a) => a.default).map((a) => a.id)).toEqual(['view']);
    const holder = computeEffectiveAccess({
      ...base,
      role: StaffRole.TEACHER,
      roleKeys: ['attendance.student.rollcall.mark', 'attendance.student.rollcall.view'],
    });
    for (const a of t.actions!) expect(holder.actionIds).toContain(actionKey(id, a.id));
    const other = computeEffectiveAccess({ ...base, role: StaffRole.EMPLOYEE, roleKeys: ['attendance.self.view'] });
    expect(other.tileIds).not.toContain(id);
  });

  it('gates every student-attendance route, each on the tile whose page calls it', () => {
    const p = StudentAttendanceController.prototype;
    for (const h of ['getSummary', 'getDashboard', 'getTimeline']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('attendance.student_attendance', 'view')]);
    }
    expect(meta(p, 'bulkManualMark')?.actionKeys).toEqual([actionKey('attendance.student_attendance', 'mark')]);
    expect(meta(p, 'resolveAttendance')?.actionKeys).toEqual([actionKey('attendance.student_attendance', 'resolve')]);
    expect(meta(p, 'getAttendanceMatrix')?.actionKeys).toEqual([actionKey('attendance.student_attendance_cycle', 'view')]);
    expect(meta(p, 'exportAttendanceMatrix')?.actionKeys).toEqual([actionKey('attendance.student_attendance_cycle', 'export')]);
    expect(meta(p, 'getQuickCheckState')?.actionKeys).toEqual([actionKey('attendance.quick_check_in', 'view')]);
    expect(meta(p, 'manualScan')?.actionKeys).toEqual([actionKey('attendance.quick_check_in', 'scan')]);
    assertEveryRouteAccountedFor(StudentAttendanceController, {});
    const guards: unknown[] = Reflect.getMetadata('__guards__', StudentAttendanceController) ?? [];
    expect(guards).toContain(TileActionGuard);
    keysExist(['getSummary', 'bulkManualMark', 'resolveAttendance', 'getAttendanceMatrix', 'exportAttendanceMatrix', 'getQuickCheckState', 'manualScan'].flatMap((h) => meta(p, h)!.actionKeys));
  });

  it('keeps the roll-session routes open to the Timetables page that shares them, and skip to A-Level Roll Call alone', () => {
    const p = RollSessionsController.prototype;
    for (const h of ['findAll', 'findOne']) {
      expect(meta(p, h)?.actionKeys).toEqual(['attendance.alevel_roll_call#view', 'attendance.timetables#view']);
    }
    for (const h of ['create', 'update', 'revert']) {
      expect(meta(p, h)?.actionKeys).toEqual(['attendance.alevel_roll_call#mark', 'attendance.timetables#view']);
    }
    expect(meta(p, 'skip')?.actionKeys).toEqual([actionKey('attendance.alevel_roll_call', 'skip')]);
    assertEveryRouteAccountedFor(RollSessionsController, {});
    keysExist(['findAll', 'create', 'skip'].flatMap((h) => meta(p, h)!.actionKeys));
  });

  it('lets a holder of ONLY the Timetables tile reach the shared roll-session routes', () => {
    const r = computeEffectiveAccess({ ...base, role: StaffRole.CAMPUS_ADMIN, roleKeys: ['hr.timetable.view', 'hr.timetable.manage'] });
    const held = new Set(r.actionIds);
    expect(r.tileIds).not.toContain('attendance.alevel_roll_call');
    for (const h of ['findAll', 'create']) {
      expect(meta(RollSessionsController.prototype, h)!.actionKeys.some((k) => held.has(k))).toBe(true);
    }
  });
});

describe('ZK Device Logs', () => {
  const t = tile('attendance.zk_device_logs');
  const Z = 'attendance.zk_device_logs';

  // These routes were locked to SUPER_ADMIN by raw role checks; the tile's
  // capability is system.permissions.manage, so a bridge would hand them to every
  // holder of that capability.
  it('has NO legacy bridge and one default action', () => {
    expect(t.legacyFullAccessCapabilities).toBeUndefined();
    expect(t.actions!.filter((a) => a.default).map((a) => a.id)).toEqual(['view']);
    const holder = computeEffectiveAccess({ ...base, role: StaffRole.EMPLOYEE, roleKeys: ['system.permissions.manage'] });
    expect(holder.tileIds).toContain(Z);
    expect(holder.actionIds.filter((k) => k.startsWith(`${Z}#`))).toEqual([actionKey(Z, 'view')]);
    const sa = computeEffectiveAccess({ ...base, role: StaffRole.SUPER_ADMIN });
    for (const a of t.actions!) expect(sa.actionIds).toContain(actionKey(Z, a.id));
  });

  it('no longer hard-codes a SUPER_ADMIN check in any of the three controllers', () => {
    expect((ZkAttendanceMappingController.prototype as any).assertSuperAdmin).toBeUndefined();
    expect((ZkScanResolutionController.prototype as any).assertSuperAdmin).toBeUndefined();
  });

  it('gates the global mapping routes and leaves per-person create / edit to the directories', () => {
    const p = ZkAttendanceMappingController.prototype;
    for (const h of ['collisionCheck', 'pinLookup', 'getUnmapped']) expect(meta(p, h)?.actionKeys).toEqual([actionKey(Z, 'mappings.view')]);
    expect(meta(p, 'simulateScan')?.actionKeys).toEqual([actionKey(Z, 'simulate')]);
    expect(meta(p, 'deleteMapping')?.actionKeys).toEqual([actionKey(Z, 'mappings.delete')]);
    for (const h of ['createMapping', 'updateMapping', 'getMappings']) expect(meta(p, h)).toBeUndefined();
    const guards: unknown[] = Reflect.getMetadata('__guards__', ZkAttendanceMappingController) ?? [];
    expect(guards).toContain(TileActionGuard);
  });

  it('gates every scan-resolution route and the device log', () => {
    const p = ZkScanResolutionController.prototype;
    for (const h of ['resolve', 'previewLink', 'previewUnlink']) expect(meta(p, h)?.actionKeys).toEqual([actionKey(Z, 'resolve')]);
    expect(meta(p, 'drift')?.actionKeys).toEqual([actionKey(Z, 'mappings.view')]);
    assertEveryRouteAccountedFor(ZkScanResolutionController, {});
    expect(meta(ZkLogsController.prototype, 'getLogs')?.actionKeys).toEqual([actionKey(Z, 'view')]);
    keysExist(['resolve', 'drift'].flatMap((h) => meta(p, h)!.actionKeys).concat(meta(ZkLogsController.prototype, 'getLogs')!.actionKeys));
  });

  describe('routes that reach every campus need an unrestricted caller', () => {
    const scope = new ScopeService({} as any);
    const user = (role: string, extra: Record<string, unknown> = {}) =>
      ({ sub: 'u', role, campusId: null, allowedClassIds: [], userType: 'STAFF', permissions: [], actions: [Z + '#*'],
         scope: { campuses: [], segments: [], classes: [], sections: [], departments: [], staffCategories: [] }, ...extra }) as any;
    const scoped = user('PRINCIPAL', { scope: { campuses: [3], segments: [], classes: [], sections: [], departments: [], staffCategories: [] } });
    const legacy = user('PRINCIPAL', { campusId: 3 });

    it('the device log', async () => {
      const zk: any = { getLogs: jest.fn().mockResolvedValue({ logs: [], nextCursor: null }), getDistinctDevices: jest.fn().mockResolvedValue([]) };
      const c = new ZkLogsController(zk, {} as any, scope);
      await expect(c.getLogs({} as any, scoped)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.getLogs({} as any, legacy)).rejects.toBeInstanceOf(ForbiddenException);
      expect(zk.getLogs).not.toHaveBeenCalled();
      await expect(c.getLogs({} as any, user('PRINCIPAL'))).resolves.toBeDefined();
      await expect(c.getLogs({} as any, user('SUPER_ADMIN'))).resolves.toBeDefined();
    });

    it('listing every mapping, pin lookup, unmapped pins and delete; one person\'s mappings stay open', async () => {
      const svc: any = { getMappings: jest.fn().mockResolvedValue([]), getUnmappedPins: jest.fn().mockResolvedValue([]), lookupPin: jest.fn(), deleteMapping: jest.fn() };
      const c = new ZkAttendanceMappingController(svc, scope);
      await expect(c.getMappings(undefined, undefined, scoped)).rejects.toBeInstanceOf(ForbiddenException);
      // without the ZK action, even an unrestricted caller cannot list them all
      await expect(c.getMappings(undefined, undefined, user('PRINCIPAL', { actions: [] }))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.getMappings(undefined, undefined, user('PRINCIPAL'))).resolves.toBeDefined();
      await expect(c.getMappings(undefined, undefined, user('SUPER_ADMIN', { actions: [] }))).resolves.toBeDefined();
      // ONE person's mappings: the directories' path, unchanged, for anyone
      await expect(c.getMappings('5', undefined, scoped)).resolves.toBeDefined();
      await expect(c.getUnmapped(scoped)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.pinLookup('1', undefined, scoped)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.deleteMapping(1, scoped)).rejects.toBeInstanceOf(ForbiddenException);
      expect(svc.deleteMapping).not.toHaveBeenCalled();
    });

    it('scan resolution', async () => {
      const res: any = { resolve: jest.fn(), previewLink: jest.fn(), previewUnlink: jest.fn(), drift: jest.fn() };
      const c = new ZkScanResolutionController(res, scope);
      await expect(c.resolve({} as any, scoped)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.previewLink({} as any, scoped)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(c.previewUnlink({} as any, scoped)).rejects.toBeInstanceOf(ForbiddenException);
      expect(res.resolve).not.toHaveBeenCalled();
    });
  });
});
