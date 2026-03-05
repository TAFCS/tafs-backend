import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { fee_frequency } from '@prisma/client';

class FeeTypeUpdateItemDto {
  @IsInt()
  id: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(fee_frequency)
  freq?: fee_frequency;

  @IsOptional()
  @IsObject()
  breakup?: Record<string, any>;
}

export class BulkUpdateFeeTypesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FeeTypeUpdateItemDto)
  items: FeeTypeUpdateItemDto[];
}

