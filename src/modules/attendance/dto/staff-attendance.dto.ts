import { ArrayMaxSize, IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { StaffAttendanceStatus } from '@prisma/client';
import { toNumberArray } from '../../../common/transforms/query-array.transform';

export class GetStaffAttendanceQueryDto {
  @IsDateString()
  date: string;

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  campus_id?: number[];

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  department_id?: number[];
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** TAFSD-484: one break on an overridden day. */
export class StaffBreakDto {
  @Matches(HHMM, { message: 'break start must be HH:mm' })
  start_time: string;

  @Matches(HHMM, { message: 'break end must be HH:mm' })
  end_time: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class StaffAttendanceMarkDto {
  @Type(() => Number)
  @IsInt()
  employee_id: number;

  @IsEnum(StaffAttendanceStatus)
  status: StaffAttendanceStatus;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  check_in_time?: string;

  @IsOptional()
  @IsString()
  check_out_time?: string;

  /** Breaks taken that day. Left out keeps the breaks already saved; [] records none. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => StaffBreakDto)
  breaks?: StaffBreakDto[];
}

export class BulkMarkStaffAttendanceDto {
  @IsDateString()
  date: string;

  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StaffAttendanceMarkDto)
  records: StaffAttendanceMarkDto[];
}

export class GetStaffTimelineQueryDto {
  @IsDateString()
  date_from: string;

  @IsDateString()
  date_to: string;
}

export class GetStaffDayHistoryQueryDto {
  @IsDateString()
  date: string;
}

export class GetMyStaffAttendanceQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be YYYY-MM' })
  period: string;
}
