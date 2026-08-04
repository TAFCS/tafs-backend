import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { StaffRole } from '@prisma/client';

const GLOBAL_AUDIT_ROLES: StaffRole[] = [
  StaffRole.SUPER_ADMIN,
  StaffRole.CAMPUS_ADMIN,
  StaffRole.PRINCIPAL,
];

const DIRECTORY_PERMS = [
  'students.directory.view',
  'students.directory.edit',
];

@Injectable()
export class AuditLogsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || user.userType !== 'STAFF') {
      return false;
    }

    if (GLOBAL_AUDIT_ROLES.includes(user.role)) {
      return true;
    }

    // Directory staff may read a single student's timeline only.
    const rawStudentId = request.query?.student_id;
    const studentId = rawStudentId != null && rawStudentId !== ''
      ? Number(rawStudentId)
      : NaN;
    if (!Number.isFinite(studentId) || studentId <= 0) {
      return false;
    }

    const permissions: string[] = Array.isArray(user.permissions)
      ? user.permissions
      : [];
    return DIRECTORY_PERMS.some((p) => permissions.includes(p));
  }
}
