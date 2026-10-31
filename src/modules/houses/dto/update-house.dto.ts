import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateHouseDto {
  @IsOptional()
  @IsString()
  house_name?: string;

  @IsOptional()
  @IsString()
  house_color?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
