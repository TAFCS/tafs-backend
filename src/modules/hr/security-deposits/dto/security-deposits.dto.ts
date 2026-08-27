import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SecurityDepositStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const OPEN_STATUS_FILTER = [SecurityDepositStatus.ACTIVE, SecurityDepositStatus.COMPLETED] as const;

export class ListSecurityDepositsQueryDto {
  @ApiPropertyOptional({ enum: OPEN_STATUS_FILTER, description: 'Filter open plans by status' })
  @IsOptional()
  @IsEnum(SecurityDepositStatus)
  @IsIn(OPEN_STATUS_FILTER)
  status?: SecurityDepositStatus;
}

export class CreateSecurityDepositDto {
  @ApiProperty({ example: 50000, description: 'Total caution-money amount to recover from salary' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  total_amount: number;

  @ApiProperty({ example: 5, description: 'Number of monthly payroll installments' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  installment_count: number;

  @ApiPropertyOptional({ example: '2026-07-26', description: 'Payroll cycle start date this plan begins on. Defaults to the current cycle.' })
  @IsOptional()
  @IsDateString()
  start_period_start?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdateInstallmentScheduleDto {
  @ApiProperty({ type: [Number], example: [10000, 10000, 5000], description: 'Remaining monthly amounts in order. Must sum to what is still left to collect.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(120)
  @Transform(({ value }) => (Array.isArray(value) ? value.map((item: unknown) => Number(item)) : value))
  @IsNumber({ maxDecimalPlaces: 2 }, { each: true })
  @Min(0.01, { each: true })
  installment_amounts: number[];
}

export class RefundSecurityDepositDto {
  @ApiProperty({ example: 10000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ForfeitSecurityDepositDto {
  @ApiProperty({ example: 5000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @ApiProperty({ example: 'Damage to classroom equipment' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}
