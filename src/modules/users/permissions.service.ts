import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { AccessService } from '../access/access.service';

@Injectable()
export class PermissionsService {
  constructor(
    @Inject(forwardRef(() => AccessService))
    private readonly accessService: AccessService,
  ) {}

  /**
   * Resolves the effective permissions for a user.
   * Additive: role baseline ∪ pack tiles ∪ allow grants ∪ user_permissions true,
   * minus exclusive denied-tile keys, minus user_permissions false.
   */
  async getEffectivePermissions(userId: string, role: StaffRole): Promise<string[]> {
    const { capabilityKeys } = await this.getEffectiveAccess(userId, role);
    return capabilityKeys;
  }

  async getEffectiveAccess(userId: string, role: StaffRole) {
    return this.accessService.resolveEffective(userId, role);
  }
}
