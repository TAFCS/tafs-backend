import { StaffRole } from '@prisma/client';
import { computeEffectiveAccess, type EffectiveTile } from './access.effective';

const tiles: EffectiveTile[] = [
  { id: 'finance.vouchers', capabilities: ['finance.vouchers.view'] },
  { id: 'finance.pending_release', capabilities: ['finance.vouchers.release'] },
  { id: 'finance.payment_history', capabilities: ['finance.vouchers.view'] },
  { id: 'student.directory', capabilities: ['students.directory.view'] },
  { id: 'hr.payroll', capabilities: ['hr.payroll.view'] },
];

const allKeys = [
  'finance.vouchers.view',
  'finance.vouchers.release',
  'students.directory.view',
  'hr.payroll.view',
  'hr.leave.apply',
];

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
