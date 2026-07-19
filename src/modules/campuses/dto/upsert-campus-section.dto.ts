import { IsBoolean, IsEnum, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { SectionGenderMode } from '@prisma/client';

export class UpsertCampusSectionDto {
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  student_capacity?: number | null;

  @IsOptional()
  @IsEnum(SectionGenderMode)
  gender_mode?: SectionGenderMode;
}
