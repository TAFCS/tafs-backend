import { IsDateString, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

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
