import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateHouseDto {
  @IsString()
  @IsNotEmpty()
  house_name: string;

  @IsOptional()
  @IsString()
  house_color?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
