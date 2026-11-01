import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  toNumberArray,
  toStringArray,
} from '../../../common/transforms/query-array.transform';
import {
  STUDENT_LIST_STATUSES,
  type StudentListStatus,
} from '../../students/dto/get-students.dto';
import {
  STRENGTH_ROW_LEVELS,
  STRENGTH_SPLITS,
  type StrengthRowLevel,
  type StrengthSplit,
} from '../strength.util';

export const STRENGTH_GENDERS = ['MALE', 'FEMALE', 'UNKNOWN'] as const;

/** TAFSD-451: filters and layout of the Student Strength report. Every filter is multi-select; empty means all. */
export class StudentStrengthQueryDto {
  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  campus_id?: number[];

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  class_id?: number[];

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  section_id?: number[];

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  house_id?: number[];

  /** Empty: every status ("everyone on roll"). */
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsIn(STUDENT_LIST_STATUSES as unknown as string[], { each: true })
  status?: StudentListStatus[];

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsIn(STRENGTH_GENDERS as unknown as string[], { each: true })
  gender?: (typeof STRENGTH_GENDERS)[number][];

  /** How deep the rows go: campus, campus → class, or campus → class → section. */
  @IsOptional()
  @IsIn(STRENGTH_ROW_LEVELS as unknown as string[])
  rows?: StrengthRowLevel;

  @IsOptional()
  @IsIn(STRENGTH_SPLITS as unknown as string[])
  split?: StrengthSplit;

  /** Crossed with `split` ("House × Gender"). */
  @IsOptional()
  @IsIn(STRENGTH_SPLITS as unknown as string[])
  split2?: StrengthSplit;
}

/** The students behind one cell of the grid. */
export class StudentStrengthCellQueryDto extends StudentStrengthQueryDto {
  /** A row key from the grid ("c:1|k:5"); omitted for the grand total row. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  row?: string;

  /** A column key from the grid; omitted for the row's total. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  column?: string;
}

/** Excel only: the school sheet format the defaulters report uses. */
export class ExportStudentStrengthQueryDto extends StudentStrengthQueryDto {
  @IsOptional()
  @IsIn(['xlsx'])
  format?: 'xlsx';
}
