import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CaslAbilityFactory,
  AppAbility,
} from '../../modules/auth/casl/casl-ability.factory';
import {
  CHECK_POLICIES_KEY,
  PolicyHandler,
} from '../../decorators/check-policies.decorator';
import {
  IJwtStaffPayload,
  IJwtParentPayload,
} from '../../modules/auth/interfaces/jwt-payload.interface';

@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private caslAbilityFactory: CaslAbilityFactory,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const policyHandlers =
      this.reflector.get<PolicyHandler[]>(
        CHECK_POLICIES_KEY,
        context.getHandler(),
      ) ?? [];

    if (policyHandlers.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user: IJwtStaffPayload | IJwtParentPayload = request.user;

    const ability: AppAbility =
      user.userType === 'STAFF'
        ? this.caslAbilityFactory.createForStaff(user as IJwtStaffPayload)
        : this.caslAbilityFactory.createForParent(user as IJwtParentPayload);

    return policyHandlers.every((handler) =>
      typeof handler === 'function' ? handler(ability) : handler.handle(ability),
    );
  }
}
