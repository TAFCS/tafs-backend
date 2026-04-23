import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class CreateBundleNameDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  description?: string;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}

export class UpdateBundleNameDto extends CreateBundleNameDto {}
