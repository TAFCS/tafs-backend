import { AttendanceObjectionStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

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
  @IsEnum(AttendanceObjectionStatus)
  status?: AttendanceObjectionStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  campus_id?: number;
}

export class ReviewAttendanceObjectionDto {
  @IsEnum(AttendanceObjectionStatus)
  status: AttendanceObjectionStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  admin_notes?: string;
}
