import { ForbiddenException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { assertMayChangeEmployee, assertMayChangeRecordOf } from './super-admin';

const SA = { role: StaffRole.SUPER_ADMIN, sub: 'sa' };
const HR = { role: StaffRole.CAMPUS_ADMIN, sub: 'hr' };

describe('assertMayChangeRecordOf', () => {
  it('lets a delegate change someone else\'s record', () => {
    expect(() => assertMayChangeRecordOf(HR, { userId: 'other', userRole: StaffRole.EMPLOYEE }, 'r')).not.toThrow();
  });

  it('refuses a delegate their own record', () => {
    expect(() => assertMayChangeRecordOf(HR, { userId: 'hr', userRole: StaffRole.CAMPUS_ADMIN }, 'r')).toThrow(/your own/);
  });

  it('refuses a delegate a SUPER_ADMIN\'s record', () => {
    expect(() => assertMayChangeRecordOf(HR, { userId: 'sa', userRole: StaffRole.SUPER_ADMIN }, 'r')).toThrow(/super admin/);
  });

  it('lets a SUPER_ADMIN change anything, their own record included', () => {
    expect(() => assertMayChangeRecordOf(SA, { userId: 'sa', userRole: StaffRole.SUPER_ADMIN }, 'r')).not.toThrow();
  });

  it('never blocks on a record with no login', () => {
    expect(() => assertMayChangeRecordOf(HR, { userId: null }, 'r')).not.toThrow();
  });
});

describe('assertMayChangeEmployee', () => {
  const prisma = (row: unknown) => ({ employee_profiles: { findUnique: jest.fn().mockResolvedValue(row) } });

  it('skips the lookup for a SUPER_ADMIN', async () => {
    const p = prisma(null);
    await assertMayChangeEmployee(p as any, SA, 1, 'r');
    expect(p.employee_profiles.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a delegate acting on their own employee record', async () => {
    await expect(
      assertMayChangeEmployee(prisma({ user_id: 'hr', users: { role: StaffRole.CAMPUS_ADMIN } }) as any, HR, 1, 'loan'),
    ).rejects.toThrow(ForbiddenException);
  });
});
