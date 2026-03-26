import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { ClassSelectorDto } from './class-selector.dto';

export class PromoteBulkStudentsDto {
  @ValidateNested()
  @Type(() => ClassSelectorDto)
  from!: ClassSelectorDto;

  @ValidateNested()
  @Type(() => ClassSelectorDto)
  to!: ClassSelectorDto;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  campus_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  section_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  to_section_id?: number;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  student_ids?: number[];

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}
