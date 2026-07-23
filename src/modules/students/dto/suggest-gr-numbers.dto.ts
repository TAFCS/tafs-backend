import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

export class SuggestGrNumbersDto {
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  student_ccs: number[];

  @IsOptional()
  @IsBoolean()
  a_level?: boolean;

  /** Allocate against this campus (e.g. Johar when moving from GKF/NN). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  target_campus_id?: number;
}
