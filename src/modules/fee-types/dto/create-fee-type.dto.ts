import { IsEnum, IsInt, IsObject, IsOptional, IsString } from 'class-validator';
import { fee_frequency } from '@prisma/client';

export class CreateFeeTypeDto {
  @IsString()
  description: string;

  @IsOptional()
  @IsEnum(fee_frequency)
  freq?: fee_frequency;

  @IsOptional()
  @IsObject()
  breakup?: Record<string, any>;

  @IsOptional()
  @IsInt()
  priority_order?: number;
}

