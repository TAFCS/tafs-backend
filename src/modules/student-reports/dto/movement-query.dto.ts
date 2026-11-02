import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  toNumberArray,
  toStringArray,
} from '../../../common/transforms/query-array.transform';
import {
  DEPARTURE_TYPES,
  MOVEMENT_MEASURES,
  MOVEMENT_PERIODS,
  MOVEMENT_ROWS,
  type DepartureType,
  type MovementMeasure,
  type MovementPeriod,
  type MovementRows,
} from '../movement.util';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** TAFSD-453: Admissions and Withdrawals (report C). */
export class MovementQueryDto {
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

  /** Admissions, withdrawals, or both with the net change. Omitted: both. */
  @IsOptional()
  @IsIn(MOVEMENT_MEASURES as unknown as string[])
  measure?: MovementMeasure;

  @IsOptional()
  @IsIn(MOVEMENT_ROWS as unknown as string[])
  rows?: MovementRows;

  /** Columns: each month, or each session (August to July). */
  @IsOptional()
  @IsIn(MOVEMENT_PERIODS as unknown as string[])
  period?: MovementPeriod;

  /** YYYY-MM-DD. Omitted: the start of this session. */
  @IsOptional()
  @Matches(DATE)
  from?: string;

  /** YYYY-MM-DD. Omitted: today. */
  @IsOptional()
  @Matches(DATE)
  to?: string;

  /** What counts as a withdrawal. Omitted: Left only. */
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsIn(DEPARTURE_TYPES as unknown as string[], { each: true })
  departures?: DepartureType[];
}

export class MovementCellQueryDto extends MovementQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  row?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  column?: string;
}

export class ExportMovementQueryDto extends MovementQueryDto {
  @IsOptional()
  @IsIn(['xlsx', 'pdf'])
  format?: 'xlsx' | 'pdf';

  @IsOptional()
  @IsIn(['A4', 'A3'])
  paper?: 'A4' | 'A3';

  /** The counts, or the list of every admission / withdrawal behind them. Omitted: counts. */
  @IsOptional()
  @IsIn(['summary', 'list'])
  part?: 'summary' | 'list';
}
