import { IsArray, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
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
}

export class BulkUpdateClassesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClassUpdateItemDto)
  items: ClassUpdateItemDto[];
}

