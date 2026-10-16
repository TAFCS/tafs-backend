import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StaffRole } from '@prisma/client';
import { actionsCover, userHoldsTile } from '../../modules/access/tiles.manifest';
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
    if (meta?.mode === 'tile' && (meta.tileIds?.length ?? 0) > 0) {
      return this.canActivateForTiles(context, meta.tileIds!);
    }
    if (!meta || meta.actionKeys.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user: IJwtStaffPayload | IJwtParentPayload | undefined = request.user;

    // Dual-surface endpoints (e.g. support tickets): parents have no ERP staff
    // tile actions; their access is bounded by PoliciesGuard and family-scoping.
    if (user && user.userType === 'PARENT') {
      return true;
    }

    if (!user || user.userType !== 'STAFF') {
      throw new ForbiddenException('Staff session required.');
    }

    const staff = user as IJwtStaffPayload;
    if (staff.role === StaffRole.SUPER_ADMIN) return true;

    // actionsCover, not held.has: a claim may carry `tile#*` for a tile the
    // user holds in full (see compactActionKeys). Tokens issued before that
    // shipped carry the expanded list and match just the same.
    const held = new Set(staff.actions ?? []);
    const ok =
      meta.mode === 'any'
        ? meta.actionKeys.some((k) => actionsCover(held, k))
        : meta.actionKeys.every((k) => actionsCover(held, k));

    if (!ok) {
      throw new ForbiddenException(
        `Missing permission: ${meta.actionKeys.join(meta.mode === 'any' ? ' or ' : ', ')}.`,
      );
    }
    return true;
  }

  /** @RequireAnyTile: staff only, SUPER_ADMIN always, otherwise a holder of any listed tile. */
  private canActivateForTiles(context: ExecutionContext, tileIds: string[]): boolean {
    const user: IJwtStaffPayload | IJwtParentPayload | undefined = context.switchToHttp().getRequest().user;
    if (!user || user.userType !== 'STAFF') {
      throw new ForbiddenException('Staff session required.');
    }
    const staff = user as IJwtStaffPayload;
    if (staff.role === StaffRole.SUPER_ADMIN) return true;
    if (tileIds.some((id) => userHoldsTile(staff, id))) return true;
    throw new ForbiddenException('Your access does not include this lookup.');
  }
}
