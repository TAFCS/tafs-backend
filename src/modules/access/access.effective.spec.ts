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

  describe('legacy bridge on a tile whose own capability is its bridge key', () => {
    const CYCLE_ACTIONS = [
      { id: 'view', default: true, implies: [] },
      { id: 'export', default: false, implies: ['view'] },
      { id: 'mark', default: false, implies: ['view'] },
    ];
    const cycleTiles: EffectiveTile[] = [
      ...tiles,
      {
        id: 'attendance.employee_attendance_cycle',
        capabilities: ['hr.payroll.view'],
        actions: CYCLE_ACTIONS,
        legacyFullAccessCapabilities: ['hr.payroll.manage', 'hr.payroll.view'],
      },
    ];
    const cycle = (ids: string[]) => ids.map((id) => `attendance.employee_attendance_cycle#${id}`).sort();

    it('a per-user tile grant confers only default actions, not Resolve/Edit', () => {
      const result = computeEffectiveAccess({
        ...base,
        activeTiles: cycleTiles,
        role: StaffRole.EMPLOYEE,
        allowTileIds: ['attendance.employee_attendance_cycle'],
      });
      expect(result.tileIds).toContain('attendance.employee_attendance_cycle');
      expect(result.actionIds.filter((a) => a.startsWith('attendance.employee_attendance_cycle#')).sort())
        .toEqual(cycle(['view']));
    });

    it('a pack tile grant confers only default and pack actions', () => {
      const result = computeEffectiveAccess({
        ...base,
        activeTiles: cycleTiles,
        role: StaffRole.EMPLOYEE,
        packTileIds: ['attendance.employee_attendance_cycle'],
        packActions: [{ tileId: 'attendance.employee_attendance_cycle', actionId: 'export' }],
      });
      expect(result.actionIds.filter((a) => a.startsWith('attendance.employee_attendance_cycle#')).sort())
        .toEqual(cycle(['export', 'view']));
    });

    it('the bridge key from a role baseline still confers every action', () => {
      const result = computeEffectiveAccess({
        ...base,
        activeTiles: cycleTiles,
        role: StaffRole.CAMPUS_ADMIN,
        roleKeys: ['hr.payroll.view'],
      });
      expect(result.actionIds.filter((a) => a.startsWith('attendance.employee_attendance_cycle#')).sort())
        .toEqual(cycle(['export', 'mark', 'view']));
    });

    it('a direct user permission revoking the bridge key ends the bridge', () => {
      const result = computeEffectiveAccess({
        ...base,
        activeTiles: cycleTiles,
        role: StaffRole.CAMPUS_ADMIN,
        roleKeys: ['hr.payroll.view'],
        allowTileIds: ['attendance.employee_attendance_cycle'],
        userPerms: [{ key: 'hr.payroll.view', granted: false }],
      });
      expect(result.actionIds).not.toContain('attendance.employee_attendance_cycle#mark');
    });
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

  describe('web tiles are not-allowed by default (TAFSD-284)', () => {
    const webTiles = tiles.map((t) => ({ ...t, requiresExplicitAllow: true }));

    it('hides a web tile the role or a pack would have granted', () => {
      const result = computeEffectiveAccess({
        ...base,
        activeTiles: webTiles,
        role: StaffRole.PRINCIPAL,
        roleKeys: ['finance.vouchers.view'],
        packTileIds: ['student.directory'],
      });

      expect(result.tileIds).toEqual([]);
    });

    it('shows a web tile only on an explicit per-user allow', () => {
      const result = computeEffectiveAccess({
        ...base,
        activeTiles: webTiles,
        role: StaffRole.EMPLOYEE,
        allowTileIds: ['finance.vouchers'],
      });

      expect(result.tileIds).toEqual(['finance.vouchers']);
    });

    it('SUPER_ADMIN still holds every web tile', () => {
      const result = computeEffectiveAccess({ ...base, activeTiles: webTiles, role: StaffRole.SUPER_ADMIN });

      expect(result.tileIds).toEqual(webTiles.map((t) => t.id));
    });
  });
});

describe('superAdminOnly tiles (TAFSD-327)', () => {
  const hierarchy: EffectiveTile = {
    id: 'system.reporting_hierarchy',
    capabilities: ['system.permissions.manage'],
    superAdminOnly: true,
  };
  const withHierarchy = {
    ...base,
    allPermissionKeys: [...allKeys, 'system.permissions.manage'],
    activeTiles: [...tiles, hierarchy],
  };

  it('never resolves for anyone else, even when granted and the capability is held', () => {
    const out = computeEffectiveAccess({
      ...withHierarchy,
      role: StaffRole.CAMPUS_ADMIN,
      roleKeys: ['system.permissions.manage'],
      allowTileIds: ['system.reporting_hierarchy'],
      packTileIds: ['system.reporting_hierarchy'],
    });
    expect(out.tileIds).not.toContain('system.reporting_hierarchy');
  });

  it('resolves for SUPER_ADMIN', () => {
    const out = computeEffectiveAccess({ ...withHierarchy, role: StaffRole.SUPER_ADMIN });
    expect(out.tileIds).toContain('system.reporting_hierarchy');
  });
});
