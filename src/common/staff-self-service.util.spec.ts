import { ForbiddenException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import {
  ATTENDANCE_SELF_VIEW,
  LEAVE_APPLY,
  PAYROLL_SELF_VIEW,
  assertStaffSelfPermission,
  hasStaffSelfPermission,
} from './staff-self-service.util';

const staff = (role: StaffRole, permissions: string[] = []) =>
  ({
    sub: 'u1',
    username: 'alice',
    role,
    campusId: null,
    allowedClassIds: [],
    userType: 'STAFF' as const,
    permissions,
  }) as any;

describe('hasStaffSelfPermission / assertStaffSelfPermission', () => {
  // Regression: a SUPER_ADMIN's `permissions` claim is deliberately emptied
  // at login to keep the token small (every other guard special-cases the
  // role instead of reading it). This check didn't, so a SUPER_ADMIN was
  // refused their own attendance, payroll and leave self-service routes on
  // both web and the Staff App -- it only looked web-specific because most
  // people testing on web use an EMPLOYEE-role account, whose array isn't
  // emptied.
  it('always grants SUPER_ADMIN, regardless of an empty permissions claim', () => {
    const sa = staff(StaffRole.SUPER_ADMIN, []);
    expect(hasStaffSelfPermission(sa, ATTENDANCE_SELF_VIEW)).toBe(true);
    expect(hasStaffSelfPermission(sa, PAYROLL_SELF_VIEW)).toBe(true);
    expect(hasStaffSelfPermission(sa, LEAVE_APPLY)).toBe(true);
    expect(() => assertStaffSelfPermission(sa, PAYROLL_SELF_VIEW)).not.toThrow();
  });

  it('still refuses any other role that does not hold the permission', () => {
    const employee = staff(StaffRole.EMPLOYEE, ['hr.leave.apply']);
    expect(hasStaffSelfPermission(employee, PAYROLL_SELF_VIEW)).toBe(false);
    expect(() => assertStaffSelfPermission(employee, PAYROLL_SELF_VIEW)).toThrow(ForbiddenException);
  });

  it('grants any other role that DOES hold the permission', () => {
    const employee = staff(StaffRole.EMPLOYEE, ['attendance.self.view', 'payroll.self.view', 'hr.leave.apply']);
    for (const key of [ATTENDANCE_SELF_VIEW, PAYROLL_SELF_VIEW, LEAVE_APPLY]) {
      expect(hasStaffSelfPermission(employee, key)).toBe(true);
      expect(() => assertStaffSelfPermission(employee, key)).not.toThrow();
    }
  });

  it('a CAMPUS_ADMIN or PRINCIPAL without the delegated permission is still refused (not everyone is exempt, only SUPER_ADMIN)', () => {
    const principal = staff(StaffRole.PRINCIPAL, ['academic.campuses.view']);
    expect(hasStaffSelfPermission(principal, PAYROLL_SELF_VIEW)).toBe(false);
    expect(() => assertStaffSelfPermission(principal, PAYROLL_SELF_VIEW)).toThrow(ForbiddenException);
  });
});
