import { AttendanceObjectionStatus } from '@prisma/client';
import { IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { toNumberArray, toStringArray } from '../../../common/transforms/query-array.transform';

export class CreateAttendanceObjectionDto {
  @IsDateString()
  attendance_date: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  scan_id?: number;

  @IsDateString()
  claimed_time: string;

  @IsString()
  @MaxLength(500)
  reason: string;
}

export class ListAttendanceObjectionsQueryDto {
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsEnum(AttendanceObjectionStatus, { each: true })
  status?: AttendanceObjectionStatus[];

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  campus_id?: number[];
}

export class ReviewAttendanceObjectionDto {
  @IsEnum(AttendanceObjectionStatus)
  status: AttendanceObjectionStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  admin_notes?: string;
}
