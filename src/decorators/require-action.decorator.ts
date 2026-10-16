import { SetMetadata } from '@nestjs/common';

export const REQUIRE_ACTION_KEY = 'require_action';

/**
 * Requires one or more tile sub-permissions, addressed as `tileId#actionId`.
 *
 *   @RequireAction('hr.employee_directory#delete')
 *
 * Sits ALONGSIDE @CheckPolicies, never replacing it: CASL keeps guarding the
 * coarse capability layer, this adds the fine one, and both must pass.
 *
 * Multiple ids are AND-ed. For an OR, use @RequireAnyAction.
 */
export const RequireAction = (...actionKeys: string[]) =>
  SetMetadata(REQUIRE_ACTION_KEY, { mode: 'all' as const, actionKeys });

export const REQUIRE_ANY_ACTION_MODE = 'any';

/** Passes when the caller holds ANY of the listed sub-permissions. */
export const RequireAnyAction = (...actionKeys: string[]) =>
  SetMetadata(REQUIRE_ACTION_KEY, { mode: 'any' as const, actionKeys });

/**
 * For a lookup feeder that many pages share (a student or employee search box).
 * Passes when the caller holds ANY of the listed tiles, whether or not those
 * tiles have sub-permissions yet. SUPER_ADMIN always passes.
 *
 * This is deliberately an allowlist of the tiles whose pages call the route,
 * not "any staff member": pinning a shared feeder to one tile's `view` locks out
 * everyone else who legitimately needs it, and dropping the gate altogether
 * would open it to people who hold none of those tiles.
 *
 * Unlike @RequireAction it does not sit ALONGSIDE the coarse capability check --
 * a user delegated a single tile has none of the unrelated capabilities that
 * check would demand, so use it INSTEAD of @CheckPolicies on the route.
 */
export const RequireAnyTile = (...tileIds: string[]) =>
  SetMetadata(REQUIRE_ACTION_KEY, { mode: 'tile' as const, actionKeys: [] as string[], tileIds });

/**
 * Only an acting SUPER_ADMIN passes. For routes that change who may do what:
 * a user's role, tiles, packs, sub-permissions, scope, capability overrides
 * and login credentials. These are never delegable, because whoever can write
 * them can write them for themselves.
 *
 * Like @RequireAnyTile it replaces the action check on the route, and it sits
 * alongside @CheckPolicies. The service repeats the check (assertSuperAdmin)
 * so a route added later without the decorator still refuses.
 */
export const RequireSuperAdmin = () =>
  SetMetadata(REQUIRE_ACTION_KEY, { mode: 'super_admin' as const, actionKeys: [] as string[] });

export type RequireActionMetadata = {
  mode: 'all' | 'any' | 'tile' | 'super_admin';
  actionKeys: string[];
  /** Only for mode 'tile'. */
  tileIds?: string[];
};
