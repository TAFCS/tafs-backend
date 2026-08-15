import { IsArray, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class ClassUpdateItemDto {
  @IsInt()
  id: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  class_code?: string;

  @IsOptional()
  @IsString()
  academic_system?: string;

  /** See CreateClassDto.term_start_month. 8 = Aug-Jul, 4 = Apr-Mar. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  term_start_month?: number;
}

export class BulkUpdateClassesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClassUpdateItemDto)
  items: ClassUpdateItemDto[];
}

