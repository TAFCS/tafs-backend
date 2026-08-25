import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
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

  @IsOptional()
  @ValidateNested()
  @Type(() => ClassSelectorDto)
  from?: ClassSelectorDto;

  /** Required when neither `graduate`, `expel`, nor `left` is true. */
  @ValidateIf((o) => !o.graduate && !o.expel && !o.left)
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

  /** Marks the student as having left (status = LEFT, all data preserved). */
  @IsOptional()
  @IsBoolean()
  left?: boolean;

  @IsOptional()
  @IsString()
  target_academic_year?: string;

  /**
   * Explicit academic year to record as graduated_academic_year — the year the
   * student was studying in when they graduated. Only meaningful when `graduate`
   * is true. If omitted, defaults to the student's own current academic_year.
   * NOT the same as `target_academic_year` (destination academic_year going
   * forward).
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, { message: 'graduated_academic_year must be in YYYY-YYYY format' })
  graduated_academic_year?: string;

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
