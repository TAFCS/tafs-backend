import 'reflect-metadata';
import { StaffRole } from '@prisma/client';
import { computeEffectiveAccess, type EffectiveTile } from './access.effective';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions';
import { ZkLogsController } from '../attendance/zk-push.controller';
import { REQUIRE_ACTION_KEY } from '../../decorators/require-action.decorator';

/**
 * TAFSD-374. Packs carry Staff App tabs; web tiles are granted per user. A web
 * tile in a pack must give nothing, and the self-service keys every employee
 * holds must not open the ERP's coarse checks.
 */
const ACTIONS = [
  { id: 'view', default: true, implies: [] },
  { id: 'delete', default: false, implies: ['view'] },
];
const tiles: EffectiveTile[] = [
  { id: 'hr.payroll', capabilities: ['hr.payroll.view'], actions: ACTIONS, requiresExplicitAllow: true },
  { id: 'system.access_packs', capabilities: ['system.permissions.manage'], requiresExplicitAllow: true },
  { id: 'staff_app.leave', capabilities: ['hr.leave.apply'] },
];
const base = {
  role: StaffRole.EMPLOYEE,
  allPermissionKeys: ['hr.payroll.view', 'system.permissions.manage', 'hr.leave.apply'],
  activeTiles: tiles,
  roleKeys: [] as string[],
  allowTileIds: [] as string[],
  denyTileIds: [] as string[],
  userPerms: [],
};

describe('packs give Staff App tabs only', () => {
  it('a web tile in a pack gives neither its tile nor its capabilities', () => {
    const out = computeEffectiveAccess({ ...base, packTileIds: ['system.access_packs', 'hr.payroll'] });
    expect(out.tileIds).toEqual([]);
    expect(out.capabilityKeys).not.toContain('system.permissions.manage');
    expect(out.capabilityKeys).not.toContain('hr.payroll.view');
  });

  it('a pack action does not widen a web tile granted directly', () => {
    const out = computeEffectiveAccess({
      ...base,
      packTileIds: ['hr.payroll'],
      packActions: [{ tileId: 'hr.payroll', actionId: 'delete' }],
      allowTileIds: ['hr.payroll'],
    });
    expect(out.tileIds).toEqual(['hr.payroll']);
    expect(out.actionIds).toEqual(['hr.payroll#view']);
  });

  it('still gives Staff App tabs', () => {
    const out = computeEffectiveAccess({ ...base, packTileIds: ['staff_app.leave'] });
    expect(out.tileIds).toEqual(['staff_app.leave']);
    expect(out.capabilityKeys).toContain('hr.leave.apply');
  });
});

describe('self-service keys open no coarse ERP check', () => {
  const factory = new CaslAbilityFactory();
  const employee = (extra: Partial<Record<string, unknown>> = {}) =>
    factory.createForStaff({
      sub: 'e', username: 'e', role: StaffRole.EMPLOYEE, campusId: null, allowedClassIds: [], userType: 'STAFF',
      permissions: ['attendance.self.view', 'payroll.self.view', 'hr.timetable.self_view', 'hr.leave.apply'],
      actions: [],
      ...extra,
    } as any);

  it('an employee with only self-service fails Payroll, StaffAttendance and Timetable', () => {
    const a = employee();
    expect(a.can(Action.Read, 'Payroll')).toBe(false);
    expect(a.can(Action.Read, 'StaffAttendance')).toBe(false);
    expect(a.can(Action.Manage, 'Timetable')).toBe(false);
    expect(a.can(Action.Read, 'Timetable')).toBe(false);
  });

  it('the shared routes keep working for the tiles that call them', () => {
    expect(employee({ actions: ['hr.employee_directory#view'] }).can(Action.Read, 'StaffAttendance')).toBe(true);
    expect(employee({ actions: ['attendance.timetables#view'] }).can(Action.Read, 'StaffAttendance')).toBe(true);
    expect(employee({ actions: ['attendance.alevel_roll_call#view'] }).can(Action.Read, 'Timetable')).toBe(true);
  });
});

describe('device health', () => {
  it('needs an attendance tile, not just any staff session', () => {
    const meta = Reflect.getMetadata(REQUIRE_ACTION_KEY, ZkLogsController.prototype.getDeviceHealth);
    expect(meta?.mode).toBe('tile');
    expect(meta?.tileIds).toContain('attendance.zk_device_logs');
  });
});
