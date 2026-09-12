import { StaffRole } from '@prisma/client';
import type { UserScope } from '../../../common/scope/scope.types';

export type { StaffRole };

export interface IJwtStaffPayload {
  sub: string;
  username: string;
  fullName?: string;
  role: StaffRole;
  campusId: number | null;
  allowedClassIds: number[];
  userType: 'STAFF';
  permissions: string[];
  /**
   * Tile sub-permissions the user holds, as `tileId#actionId`.
   * Absent on sessions issued before sub-permissions shipped.
   */
  actions?: string[];
  /**
   * Universal data scope. Absent on sessions issued before scope shipped,
   * which resolves to unrestricted — exactly what those sessions already had.
   */
  scope?: UserScope;
}

export interface IJwtParentPayload {
  sub: number;
  familyId: number;
  userType: 'PARENT';
}

export type JwtPayload = IJwtStaffPayload | IJwtParentPayload;
