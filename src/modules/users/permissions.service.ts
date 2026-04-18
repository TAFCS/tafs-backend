import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StaffRole } from '@prisma/client';

@Injectable()
export class PermissionsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Resolves the effective permissions for a user.
   * Order: Explicit Overrides (user_permissions) > Role Defaults (role_permissions)
   */
  async getEffectivePermissions(userId: string, role: StaffRole): Promise<string[]> {
    // 1. Fetch role defaults
    const rolePermissions = await this.prisma.role_permissions.findMany({
      where: { role },
      include: { permissions: true },
    });

    const effectiveMap = new Map<string, boolean>();

    // Set role defaults
    rolePermissions.forEach((rp) => {
      effectiveMap.set(rp.permissions.key, true);
    });

    // 2. Fetch user overrides
    const userOverrides = await this.prisma.user_permissions.findMany({
      where: { user_id: userId },
      include: { permissions: true },
    });

    // Apply overrides (Grant/Revoke)
    userOverrides.forEach((uo) => {
      effectiveMap.set(uo.permissions.key, uo.granted);
    });

    // 3. Collect keys that are granted (true)
    const effectivePermissions: string[] = [];
    effectiveMap.forEach((granted, key) => {
      if (granted) effectivePermissions.push(key);
    });

    return effectivePermissions;
  }
}
