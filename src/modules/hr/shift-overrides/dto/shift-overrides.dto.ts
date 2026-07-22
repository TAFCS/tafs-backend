import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsDateString, IsInt, IsOptional, IsString, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateShiftOverridesDto {
  @ApiProperty({ description: 'Employee profile ID this override applies to' })
  @IsInt()
  @Type(() => Number)
  employee_id: number;

  @ApiProperty({ type: [String], example: ['2026-03-03', '2026-03-09', '2026-03-17'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsDateString({}, { each: true })
  dates: string[];

  @ApiPropertyOptional({ example: '10:00', description: 'HH:mm — leave unset to fall through to the normal schedule' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'override_start_time must be HH:mm' })
  override_start_time?: string;

  @ApiPropertyOptional({ example: '17:00', description: 'HH:mm — leave unset to fall through to the normal schedule' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'override_end_time must be HH:mm' })
  override_end_time?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ListShiftOverridesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employee_id?: number;

  @ApiPropertyOptional({ example: '2026-03-01' })
  @IsOptional()
  @IsDateString()
  date_from?: string;

  @ApiPropertyOptional({ example: '2026-03-31' })
  @IsOptional()
  @IsDateString()
  date_to?: string;
}
