import { Type } from 'class-transformer';
import { IsInt, IsPositive } from 'class-validator';

export class HouseBalancerScopeDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  campus_id!: number;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  class_id!: number;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  section_id!: number;
}
