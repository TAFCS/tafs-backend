import { IsInt, IsPositive } from 'class-validator';
import { Type } from 'class-transformer';

export class GetByCcParamsDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  cc: number;
}

