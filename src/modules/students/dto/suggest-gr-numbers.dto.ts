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
}
