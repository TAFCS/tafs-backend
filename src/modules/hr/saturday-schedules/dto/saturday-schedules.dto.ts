import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, IsString, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSaturdayScheduleDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  campusId: number;

  @ApiProperty({ example: '2026-03-07' })
  @IsDateString()
  date: string;
}

export class ListSaturdaySchedulesQueryDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  campusId: number;

  @ApiProperty({ example: '2026-03', description: 'YYYY-MM month filter' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month: string;
}
