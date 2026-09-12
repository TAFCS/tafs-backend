import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StaffRole } from '@prisma/client';
import {
  REQUIRE_ACTION_KEY,
  type RequireActionMetadata,
} from '../../decorators/require-action.decorator';
import type {
  IJwtParentPayload,
  IJwtStaffPayload,
} from '../../modules/auth/interfaces/jwt-payload.interface';

/**
 * Enforces @RequireAction / @RequireAnyAction.
 *
 * Deliberately permissive in exactly one case: a route is only gated once it
 * carries the decorator, so adding sub-permissions to a tile changes nothing
 * until its routes opt in, one page at a time.
 */
@Injectable()
export class TileActionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<RequireActionMetadata | undefined>(
      REQUIRE_ACTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!meta || meta.actionKeys.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user: IJwtStaffPayload | IJwtParentPayload | undefined = request.user;

    if (!user || user.userType !== 'STAFF') {
      throw new ForbiddenException('Staff session required.');
    }

    const staff = user as IJwtStaffPayload;
    if (staff.role === StaffRole.SUPER_ADMIN) return true;

    const held = new Set(staff.actions ?? []);
    const ok =
      meta.mode === 'any'
        ? meta.actionKeys.some((k) => held.has(k))
        : meta.actionKeys.every((k) => held.has(k));

    if (!ok) {
      throw new ForbiddenException(
        `Missing permission: ${meta.actionKeys.join(meta.mode === 'any' ? ' or ' : ', ')}.`,
      );
    }
    return true;
  }
}
