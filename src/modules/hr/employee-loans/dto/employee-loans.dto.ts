import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LoanStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const OPEN_STATUS_FILTER = [LoanStatus.ACTIVE, LoanStatus.OUTSTANDING] as const;

export class ListLoansQueryDto {
  @ApiPropertyOptional({ enum: OPEN_STATUS_FILTER, description: 'Filter open loans by status' })
  @IsOptional()
  @IsEnum(LoanStatus)
  @IsIn(OPEN_STATUS_FILTER)
  status?: LoanStatus;
}

export class CreateLoanDto {
  @ApiProperty({ example: 50000, description: 'Total loan amount disbursed to the employee' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  total_amount: number;

  @ApiProperty({ example: 5, description: 'Number of monthly payroll installments to recover the remaining balance' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  installment_count: number;

  @ApiPropertyOptional({ example: 10000, description: 'Amount already repaid by hand before this system tracked the loan. Defaults to 0.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount_repaid_opening?: number;

  @ApiPropertyOptional({ example: '2026-06-01', description: 'Date the loan was actually disbursed. Defaults to today.' })
  @IsOptional()
  @IsDateString()
  disbursement_date?: string;

  @ApiPropertyOptional({ example: '2026-07-26', description: 'Payroll cycle start date the system begins deducting installments from. Defaults to the current cycle.' })
  @IsOptional()
  @IsDateString()
  start_period_start?: string;

  @ApiPropertyOptional({ description: 'What the loan is for' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdateInstallmentScheduleDto {
  @ApiProperty({ type: [Number], example: [10000, 10000, 5000], description: 'Remaining monthly amounts in order. Must sum to the outstanding balance.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(120)
  @Transform(({ value }) => (Array.isArray(value) ? value.map((item: unknown) => Number(item)) : value))
  @IsNumber({ maxDecimalPlaces: 2 }, { each: true })
  @Min(0.01, { each: true })
  installment_amounts: number[];
}

export class LumpSumRepaymentDto {
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

export class WriteOffLoanDto {
  @ApiProperty({ example: 5000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @ApiProperty({ example: 'Employee left, remainder forgiven by management' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}
