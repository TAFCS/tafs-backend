import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';

/**
 * Locks a route to SUPER_ADMIN, checked against the raw role — not the CASL
 * ability. `ability.can(Action.Manage, 'all')` is NOT a safe stand-in for
 * "SUPER_ADMIN only": `system.analytics.view_amounts` (held today by
 * PRINCIPAL, FINANCE_CLERK and CAMPUS_ADMIN) maps through the generic
 * capability mapper to that exact same universal grant, since it isn't a
 * '.view' action and its resource ('analytics') maps to subject 'all'. Use
 * this guard for a feature with no permission infrastructure of its own yet
 * (see Post-dated Cheques), where the only safe default is a real
 * SUPER_ADMIN-only lock — never widen it by swapping in an ability check.
 */
@Injectable()
export class SuperAdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (request.user?.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only a super admin may access this.');
    }
    return true;
  }
}
