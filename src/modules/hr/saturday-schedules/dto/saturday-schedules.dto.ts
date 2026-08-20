import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { toNumberArray } from '../../../../common/transforms/query-array.transform';

export class CreateSaturdayScheduleDto {
  @ApiProperty({
    type: [Number],
    description: 'Employee profile IDs to assign these Saturdays',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Type(() => Number)
  employeeIds: number[];

  @ApiProperty({
    type: [String],
    example: ['2026-03-07', '2026-03-14'],
    description: 'Saturday dates to assign',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsDateString({}, { each: true })
  dates: string[];
}

export class ListSaturdaySchedulesQueryDto {
  @ApiProperty({ example: '2026-03', description: 'YYYY-MM month filter' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month: string;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  campusId?: number[];

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
