import { StaffRole } from '@prisma/client';

export type { StaffRole };

export interface IJwtStaffPayload {
  sub: string;
  username: string;
  role: StaffRole;
  campusId: number | null;
  userType: 'STAFF';
  permissions: string[];
}

export interface IJwtParentPayload {
  sub: number;
  familyId: number;
  userType: 'PARENT';
}

export type JwtPayload = IJwtStaffPayload | IJwtParentPayload;
