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

export type RequireActionMetadata = {
  mode: 'all' | 'any';
  actionKeys: string[];
};
