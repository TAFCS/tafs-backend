import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ClassSelectorDto } from './class-selector.dto';

export class PromoteBulkStudentsDto {
  /**
   * Source class that students must currently be assigned to.
   * Always required (used as a filter when no student_ids are given).
   */
  @ValidateNested()
  @Type(() => ClassSelectorDto)
  from!: ClassSelectorDto;

  /**
   * Target class to promote students into.
   * Required when neither `graduate`, `expel`, nor `left` is true.
   */
  @ValidateIf((o) => !o.graduate && !o.expel && !o.left)
  @ValidateNested()
  @Type(() => ClassSelectorDto)
  to?: ClassSelectorDto;

  /**
   * When true, students are graduated:
   *   - status = GRADUATED
   *   - class_id = null
   *   - All other data is preserved
   * Mutually exclusive with `to`, `expel`, and `left`.
   */
  @IsOptional()
  @IsBoolean()
  graduate?: boolean;

  /**
   * When true, students are expelled:
   *   - status = EXPELLED
   *   - All data (class_id, section_id, etc.) is preserved as-is
   *   - No admission record is created
   * Mutually exclusive with `to`, `graduate`, and `left`.
   */
  @IsOptional()
  @IsBoolean()
  expel?: boolean;

  /**
   * When true, students are marked as left:
   *   - status = LEFT
   *   - All data is preserved as-is
   * Mutually exclusive with `to`, `graduate`, and `expel`.
   */
  @IsOptional()
  @IsBoolean()
  left?: boolean;

  /**
   * Explicit target academic year (e.g. "2025-2026").
   * If omitted, the service auto-increments from the student's current year.
   * Only meaningful for promotion — ignored for graduate/expel.
   */
  @IsOptional()
  @IsString()
  target_academic_year?: string;

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

  /**
   * Filter candidates by their CURRENT academic year (e.g. "2024-2025").
   * Useful when a class has students from multiple years (e.g. held-back students
   * from a prior year) and you only want to promote those in a specific year.
   *
   * This is a SOURCE filter on `students.academic_year`.
   * To override the DESTINATION year, use `target_academic_year` instead.
   */
  @IsOptional()
  @IsString()
  academic_year?: string;

  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}
