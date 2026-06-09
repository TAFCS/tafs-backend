import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { StaffRole } from '@prisma/client';

@Injectable()
export class AuditLogsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || user.userType !== 'STAFF') {
      return false;
    }
    return [
      StaffRole.SUPER_ADMIN,
      StaffRole.CAMPUS_ADMIN,
      StaffRole.PRINCIPAL,
    ].includes(user.role);
  }
}
