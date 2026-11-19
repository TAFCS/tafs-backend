import { ExecutionContext, HttpException, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

/** The HTTP route a tool stands in for: its controller and handler method. */
export type McpRoute = { controller: Type<unknown>; method: string };

/**
 * A request context for one route, carrying only what PoliciesGuard and
 * TileActionGuard read: the handler, its class, and request.user.
 */
export function routeContext(
  route: McpRoute,
  user: IJwtStaffPayload,
): ExecutionContext {
  const handler = (route.controller.prototype as Record<string, unknown>)[
    route.method
  ];
  if (typeof handler !== 'function') {
    throw new Error(
      `MCP tool route ${route.controller.name}.${route.method} does not exist`,
    );
  }
  const request = { user };
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => route.controller,
    getArgs: () => [request],
    getArgByIndex: (i: number) => (i === 0 ? request : undefined),
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => undefined,
      getNext: () => undefined,
    }),
    switchToRpc: () => {
      throw new Error('not rpc');
    },
    switchToWs: () => {
      throw new Error('not ws');
    },
  } as unknown as ExecutionContext;
}

/** Guards declared on the route (class-level and method-level). */
export function guardsOf(route: McpRoute): unknown[] {
  const handler = (route.controller.prototype as Record<string, unknown>)[
    route.method
  ] as object;
  return [
    ...((Reflect.getMetadata(GUARDS_METADATA, route.controller) as unknown[]) ??
      []),
    ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
  ];
}

/**
 * Decides whether a principal may use a route, by running the very guards the
 * route runs over HTTP against that route's own @CheckPolicies,
 * @RequireAction, @RequireAnyAction and @RequireAnyTile metadata. A tool is
 * therefore never wider than its endpoint, and changing an endpoint's grant
 * changes the tool with it.
 *
 * Refuses outright a route that is not behind the staff JWT guard and both
 * permission guards: such a route's access is not described by metadata
 * alone, so it cannot be mirrored safely.
 */
export class McpRouteAccess {
  private readonly policies: PoliciesGuard;
  private readonly tileActions: TileActionGuard;

  constructor(reflector: Reflector, abilityFactory: CaslAbilityFactory) {
    this.policies = new PoliciesGuard(reflector, abilityFactory);
    this.tileActions = new TileActionGuard(reflector);
  }

  static isMirrorable(route: McpRoute): boolean {
    const guards = guardsOf(route);
    return [JwtStaffGuard, PoliciesGuard, TileActionGuard].every((g) =>
      guards.includes(g),
    );
  }

  allows(route: McpRoute, user: IJwtStaffPayload): boolean {
    if (user?.userType !== 'STAFF') return false;
    if (!McpRouteAccess.isMirrorable(route)) return false;
    const ctx = routeContext(route, user);
    try {
      return (
        this.policies.canActivate(ctx) && this.tileActions.canActivate(ctx)
      );
    } catch (err) {
      if (err instanceof HttpException) return false;
      throw err;
    }
  }
}
