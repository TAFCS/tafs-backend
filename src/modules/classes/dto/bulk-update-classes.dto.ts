import { IsArray, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class ClassUpdateItemDto {
  @IsInt()
  id: number;

  @IsOptional()
  @IsString()
  description?: string;
}

export class BulkUpdateClassesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClassUpdateItemDto)
  items: ClassUpdateItemDto[];
}

