import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SecurityDepositStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

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
