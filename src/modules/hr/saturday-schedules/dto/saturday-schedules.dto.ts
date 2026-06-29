import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsDateString, IsInt, IsOptional, IsString, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSaturdayScheduleDto {
  @ApiProperty({ type: [Number], description: 'Employee profile IDs to assign this Saturday' })
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Type(() => Number)
  employeeIds: number[];

  @ApiProperty({ example: '2026-03-07' })
  @IsDateString()
  date: string;
}

export class ListSaturdaySchedulesQueryDto {
  @ApiProperty({ example: '2026-03', description: 'YYYY-MM month filter' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  campusId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sectionId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;
}
