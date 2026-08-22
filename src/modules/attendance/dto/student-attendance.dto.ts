import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RollRecordStatus, ScanDirection } from '@prisma/client';

export class GetStudentAttendanceQueryDto {
  @IsDateString()
  date: string;

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
}

export class GetStudentTimelineQueryDto {
  @IsDateString()
  date_from: string;

  @IsDateString()
  date_to: string;
}

/**
 * Payroll-cycle-independent attendance matrix for students — mirrors
 * AttendanceMatrixQueryDto in the HR payroll module, but campus_id omitted
 * means "every campus the caller can see" (see StudentAttendanceService
 * #resolveMatrixCampusIds) rather than defaulting to the caller's own
 * campus like the daily dashboard/summary endpoints do.
 */
export class GetStudentAttendanceMatrixQueryDto {
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

  @IsDateString()
  period_start: string;

  @IsDateString()
  period_end: string;
}

export class ResolveStudentAttendanceDto {
  @IsDateString()
  date: string;

  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @IsOptional()
  @IsString()
  check_in_time?: string;

  @IsString()
  check_out_time: string;
}

export class BulkManualStudentAttendanceRecordDto {
  @Type(() => Number)
  @IsInt()
  student_cc: number;

  @IsEnum(RollRecordStatus)
  status: RollRecordStatus;

  /** "HH:MM" — only honoured for PRESENT/LATE; ABSENT/EXCUSED always clear the punches. */
  @IsOptional()
  @IsString()
  check_in_time?: string;

  /** "HH:MM" — see check_in_time. */
  @IsOptional()
  @IsString()
  check_out_time?: string;
}

export class BulkManualStudentAttendanceDto {
  @IsDateString()
  date: string;

  @Type(() => Number)
  @IsInt()
  campus_id: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkManualStudentAttendanceRecordDto)
  records: BulkManualStudentAttendanceRecordDto[];
}

/**
 * Manual gate-desk check-in/check-out — the operator picks the direction
 * explicitly instead of it being derived from scan order (see
 * ZkAttendanceProcessorService.recordManualStudentScan).
 */
export class ManualStudentScanDto {
  @IsEnum(ScanDirection)
  direction: ScanDirection;
}
