import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class SetManagersDto {
  @ApiProperty({
    type: [Number],
    description: 'Employee profile ids this person reports to. Replaces the current set; [] removes every line.',
  })
  @IsArray()
  @ArrayMaxSize(5)
  @IsInt({ each: true })
  @Type(() => Number)
  manager_ids: number[];

  @ApiPropertyOptional({
    description: 'Which of manager_ids is the primary line (mirrored to reporting_manager_id). Defaults to the first.',
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  primary_manager_id?: number;
}
