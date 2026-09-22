import { ForbiddenException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import type { IJwtStaffPayload } from '../modules/auth/interfaces/jwt-payload.interface';

export const ATTENDANCE_SELF_VIEW = 'attendance.self.view';
export const PAYROLL_SELF_VIEW = 'payroll.self.view';
export const LEAVE_APPLY = 'hr.leave.apply';
export const LEAVE_APPROVE = 'hr.leave.approve';

/**
 * BUG FIX: a SUPER_ADMIN's `permissions` claim is deliberately emptied at
 * login (auth.service.ts -- `permissions: isSuperAdmin ? [] : permissions`)
 * to keep the token small, on the assumption every check special-cases the
 * role the way PoliciesGuard and TileActionGuard already do. This one didn't:
 * it read the raw array with no such exception, so every self-service route
 * (own attendance, own payroll, leave, the media leave-request check) refused
 * a SUPER_ADMIN outright -- on both web and the Staff App, since both call
 * the same check; it only looked web-specific because most people testing on
 * web are testing with an EMPLOYEE-role account, whose array isn't emptied.
 */
export function hasStaffSelfPermission(
  user: IJwtStaffPayload,
  permission: string,
): boolean {
  if (user.role === StaffRole.SUPER_ADMIN) return true;
  return user.permissions?.includes(permission) ?? false;
}

export function assertStaffSelfPermission(
  user: IJwtStaffPayload,
  permission: string,
): void {
  if (hasStaffSelfPermission(user, permission)) return;
  throw new ForbiddenException(
    `Your account does not have permission: ${permission}`,
  );
}
