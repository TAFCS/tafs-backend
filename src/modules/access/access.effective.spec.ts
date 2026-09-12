import { StaffRole } from '@prisma/client';
import { computeEffectiveAccess, type EffectiveTile } from './access.effective';

const DIRECTORY_ACTIONS = [
  { id: 'view', default: true, implies: [] },
  { id: 'profile.view', default: false, implies: ['view'] },
  { id: 'profile.edit', default: false, implies: ['profile.view'] },
  { id: 'schedule_pay.view', default: false, implies: ['view'] },
  { id: 'schedule_pay.edit', default: false, implies: ['schedule_pay.view'] },
  { id: 'delete', default: false, implies: ['view'] },
];

const tiles: EffectiveTile[] = [
  { id: 'finance.vouchers', capabilities: ['finance.vouchers.view'] },
  { id: 'finance.pending_release', capabilities: ['finance.vouchers.release'] },
  { id: 'finance.payment_history', capabilities: ['finance.vouchers.view'] },
  { id: 'student.directory', capabilities: ['students.directory.view'] },
  { id: 'hr.payroll', capabilities: ['hr.payroll.view'] },
  {
    id: 'hr.employee_directory',
    capabilities: ['hr.employees.view'],
    actions: DIRECTORY_ACTIONS,
    legacyFullAccessCapabilities: ['hr.employees.edit'],
  },
];

const allKeys = [
  'finance.vouchers.view',
  'finance.vouchers.release',
  'students.directory.view',
  'hr.payroll.view',
  'hr.leave.apply',
  'hr.employees.view',
  'hr.employees.edit',
];

const base = {
  allPermissionKeys: allKeys,
  activeTiles: tiles,
  roleKeys: [] as string[],
  packTileIds: [] as string[],
  allowTileIds: [] as string[],
  denyTileIds: [] as string[],
  userPerms: [] as { key: string; granted: boolean }[],
};

describe('AccessService.resolveEffective (computeEffectiveAccess)', () => {
  it('unions role baseline with pack tiles and allow grants', () => {
    const result = computeEffectiveAccess({
      role: StaffRole.EMPLOYEE,
      allPermissionKeys: allKeys,
      activeTiles: tiles,
      roleKeys: ['hr.leave.apply'],
      packTileIds: ['finance.vouchers', 'finance.pending_release'],
      allowTileIds: ['student.directory'],
      denyTileIds: [],
      userPerms: [],
    });

    expect([...result.capabilityKeys].sort()).toEqual(
      ['finance.vouchers.release', 'finance.vouchers.view', 'hr.leave.apply', 'students.directory.view'].sort(),
    );
    expect(result.tileIds).toEqual(
      expect.arrayContaining(['finance.vouchers', 'finance.pending_release', 'finance.payment_history', 'student.directory']),
    );
    expect(result.tileIds).not.toContain('hr.payroll');
  });

  it('removes keys exclusive to a denied tile but keeps shared keys and sibling tiles', () => {
    const result = computeEffectiveAccess({
      role: StaffRole.EMPLOYEE,
      allPermissionKeys: allKeys,
      activeTiles: tiles,
      roleKeys: [],
      packTileIds: ['finance.vouchers', 'finance.pending_release', 'finance.payment_history'],
      allowTileIds: [],
      denyTileIds: ['finance.pending_release'],
      userPerms: [],
    });

    expect(result.capabilityKeys).toContain('finance.vouchers.view');
    expect(result.capabilityKeys).not.toContain('finance.vouchers.release');
    expect(result.tileIds).toContain('finance.vouchers');
    expect(result.tileIds).toContain('finance.payment_history');
    expect(result.tileIds).not.toContain('finance.pending_release');
  });

  it('applies user_permissions last (grant adds, revoke removes)', () => {
    const result = computeEffectiveAccess({
      role: StaffRole.EMPLOYEE,
      allPermissionKeys: allKeys,
      activeTiles: tiles,
      roleKeys: ['finance.vouchers.view'],
      packTileIds: [],
      allowTileIds: [],
      denyTileIds: [],
      userPerms: [
        { key: 'hr.payroll.view', granted: true },
        { key: 'finance.vouchers.view', granted: false },
      ],
    });

    expect(result.capabilityKeys).toContain('hr.payroll.view');
    expect(result.capabilityKeys).not.toContain('finance.vouchers.view');
    expect(result.tileIds).toContain('hr.payroll');
    expect(result.tileIds).not.toContain('finance.vouchers');
  });

  it('short-circuits SUPER_ADMIN to all keys and tiles regardless of denies', () => {
    const result = computeEffectiveAccess({
      role: StaffRole.SUPER_ADMIN,
      allPermissionKeys: allKeys,
      activeTiles: tiles,
      roleKeys: [],
      packTileIds: [],
      allowTileIds: [],
      denyTileIds: ['finance.vouchers'],
      userPerms: [{ key: 'hr.payroll.view', granted: false }],
    });

    expect(result.capabilityKeys).toEqual([...allKeys]);
    expect(result.tileIds).toEqual(tiles.map((t) => t.id));
  });

  it('day-one identity: role only, no packs or grants, matches role keys', () => {
    const roleKeys = ['hr.leave.apply', 'attendance.self.view'];
    const result = computeEffectiveAccess({
      role: StaffRole.EMPLOYEE,
      allPermissionKeys: [...roleKeys, 'finance.vouchers.view'],
      activeTiles: tiles,
      roleKeys,
      packTileIds: [],
      allowTileIds: [],
      denyTileIds: [],
      userPerms: [],
    });

    expect(result.capabilityKeys).toEqual(roleKeys);
    expect(result.tileIds).toEqual([]);
  });
});

describe('tile sub-permissions', () => {
  it('grants only the default action when the tile alone is granted', () => {
    const result = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      roleKeys: ['hr.employees.view'],
    });

    expect(result.actionIds).toEqual(['hr.employee_directory#view']);
  });

  it('expands implies transitively for a pack action', () => {
    const result = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      roleKeys: ['hr.employees.view'],
      packActions: [{ tileId: 'hr.employee_directory', actionId: 'profile.edit' }],
    });

    // profile.edit -> profile.view -> view
    expect([...result.actionIds].sort()).toEqual(
      [
        'hr.employee_directory#profile.edit',
        'hr.employee_directory#profile.view',
        'hr.employee_directory#view',
      ].sort(),
    );
    expect(result.actionIds).not.toContain('hr.employee_directory#delete');
    expect(result.actionIds).not.toContain('hr.employee_directory#schedule_pay.view');
  });

  it('legacy bridge: an edit capability from the role baseline confers every action', () => {
    const result = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      roleKeys: ['hr.employees.view', 'hr.employees.edit'],
    });

    expect([...result.actionIds].sort()).toEqual(
      DIRECTORY_ACTIONS.map((a) => `hr.employee_directory#${a.id}`).sort(),
    );
  });

  it('a user deny beats a pack grant', () => {
    const result = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      roleKeys: ['hr.employees.view'],
      packActions: [{ tileId: 'hr.employee_directory', actionId: 'delete' }],
      userActionGrants: [
        { tileId: 'hr.employee_directory', actionId: 'delete', allow: false },
      ],
    });

    expect(result.actionIds).not.toContain('hr.employee_directory#delete');
    expect(result.actionIds).toContain('hr.employee_directory#view');
  });

  it('denying an action also denies anything that would have conferred it', () => {
    const result = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      roleKeys: ['hr.employees.view', 'hr.employees.edit'],
      userActionGrants: [
        { tileId: 'hr.employee_directory', actionId: 'profile.view', allow: false },
      ],
    });

    // denying view-profile must not leave edit-profile standing
    expect(result.actionIds).not.toContain('hr.employee_directory#profile.view');
    expect(result.actionIds).not.toContain('hr.employee_directory#profile.edit');
    expect(result.actionIds).toContain('hr.employee_directory#schedule_pay.edit');
  });

  it('a denied tile takes its actions with it', () => {
    const result = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      roleKeys: ['hr.employees.view', 'hr.employees.edit'],
      denyTileIds: ['hr.employee_directory'],
    });

    expect(result.tileIds).not.toContain('hr.employee_directory');
    expect(result.actionIds).toEqual([]);
  });

  it('actions do not resolve for a tile the user does not hold', () => {
    const result = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      roleKeys: [],
      packActions: [{ tileId: 'hr.employee_directory', actionId: 'delete' }],
    });

    expect(result.tileIds).not.toContain('hr.employee_directory');
    expect(result.actionIds).toEqual([]);
  });

  it('SUPER_ADMIN holds every action regardless of denies', () => {
    const result = computeEffectiveAccess({
      ...base,
      role: StaffRole.SUPER_ADMIN,
      denyTileIds: ['hr.employee_directory'],
      userActionGrants: [
        { tileId: 'hr.employee_directory', actionId: 'delete', allow: false },
      ],
    });

    expect([...result.actionIds].sort()).toEqual(
      DIRECTORY_ACTIONS.map((a) => `hr.employee_directory#${a.id}`).sort(),
    );
  });

  it('tiles with no declared actions contribute none', () => {
    const result = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      roleKeys: ['finance.vouchers.view'],
    });

    expect(result.tileIds).toContain('finance.vouchers');
    expect(result.actionIds).toEqual([]);
  });
});
