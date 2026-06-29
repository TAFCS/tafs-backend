import { ForbiddenException } from '@nestjs/common';
import type { IJwtStaffPayload } from '../modules/auth/interfaces/jwt-payload.interface';

export const ATTENDANCE_SELF_VIEW = 'attendance.self.view';
export const PAYROLL_SELF_VIEW = 'payroll.self.view';
export const LEAVE_APPLY = 'hr.leave.apply';
export const LEAVE_APPROVE = 'hr.leave.approve';

export function hasStaffSelfPermission(
  user: IJwtStaffPayload,
  permission: string,
): boolean {
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
