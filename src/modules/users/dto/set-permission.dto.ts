import { IsString, IsNotEmpty, IsBoolean, IsOptional } from 'class-validator';

export class SetPermissionDto {
  @IsString()
  @IsNotEmpty()
  permission_key: string;

  @IsBoolean()
  granted: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}
