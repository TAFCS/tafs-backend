import { IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
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

export class GetMyStaffAttendanceQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be YYYY-MM' })
  period: string;
}
