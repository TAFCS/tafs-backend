import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';

export class SearchSimpleQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  campus_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  class_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  section_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  segment_id?: number;
}
