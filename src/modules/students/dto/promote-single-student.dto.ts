import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { ClassSelectorDto } from './class-selector.dto';

export class PromoteSingleStudentDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  student_id!: number;

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
  to_section_id?: number;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  dry_run?: boolean;
}
