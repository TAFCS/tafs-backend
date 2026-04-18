import { IsEnum, IsInt, IsNotEmpty } from 'class-validator';
import { StaffRole } from '@prisma/client';

export class UpdateRolePermissionDto {
  @IsEnum(StaffRole)
  role: StaffRole;

  @IsInt()
  @IsNotEmpty()
  permission_id: number;

  @IsNotEmpty()
  granted: boolean;
}
