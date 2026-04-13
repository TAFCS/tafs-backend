import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ClassSelectorDto } from './class-selector.dto';

export class PromoteSingleStudentDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  student_id!: number;

  @ValidateNested()
  @Type(() => ClassSelectorDto)
  from!: ClassSelectorDto;

  /** Required when neither `graduate` nor `expel` is true. */
  @ValidateIf((o) => !o.graduate && !o.expel)
  @ValidateNested()
  @Type(() => ClassSelectorDto)
  to?: ClassSelectorDto;

  /** Graduates the student (status = GRADUATED, class_id = null). */
  @IsOptional()
  @IsBoolean()
  graduate?: boolean;

  /** Expels the student (status = EXPELLED, all data preserved). */
  @IsOptional()
  @IsBoolean()
  expel?: boolean;

  @IsOptional()
  @IsString()
  target_academic_year?: string;

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
