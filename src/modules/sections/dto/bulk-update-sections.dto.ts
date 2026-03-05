import { IsArray, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class SectionUpdateItemDto {
  @IsInt()
  id: number;

  @IsOptional()
  @IsString()
  description?: string;
}

export class BulkUpdateSectionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SectionUpdateItemDto)
  items: SectionUpdateItemDto[];
}
