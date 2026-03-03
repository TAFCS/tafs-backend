import { SetMetadata } from '@nestjs/common';
import { AppAbility } from '../modules/auth/casl/casl-ability.factory';

export const CHECK_POLICIES_KEY = 'check_policies';

export type PolicyHandler =
  | ((ability: AppAbility) => boolean)
  | { handle(ability: AppAbility): boolean };

export const CheckPolicies = (...handlers: PolicyHandler[]) =>
  SetMetadata(CHECK_POLICIES_KEY, handlers);
