import { IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { StaffAttendanceStatus } from '@prisma/client';

export class GetStaffAttendanceQueryDto {
  @IsDateString()
  date: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  campus_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  department_id?: number;
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
