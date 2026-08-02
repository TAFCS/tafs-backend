import { PostdatedChequeStatus } from '@prisma/client';
import { IsArray, IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { toNumberArray, toStringArray } from '../../../common/transforms/query-array.transform';

export class ListPostdatedChequesQueryDto {
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsEnum(PostdatedChequeStatus, { each: true })
  status?: PostdatedChequeStatus[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  student_id?: number;

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  campus_id?: number[];

  @IsOptional()
  @IsString()
  from_date?: string;

  @IsOptional()
  @IsString()
  to_date?: string;
}
