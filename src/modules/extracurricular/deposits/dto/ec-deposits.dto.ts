import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { EC_PAYMENT_METHODS, type EcPaymentMethod } from '../../ec.constants';

export class EcDepositLineDto {
    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    line_id: number;

    @ApiProperty({ description: 'Whole rupees' })
    @Type(() => Number)
    @IsInt()
    @Min(0)
    amount: number;
}

export class RecordEcDepositDto {
    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    voucher_id: number;

    @ApiProperty({ description: 'Whole rupees, at most the voucher balance (no excess, no family credit)' })
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100_000_000)
    amount: number;

    @ApiProperty({ enum: ['AUTO', 'MANUAL'], description: 'AUTO fills the lines in order; MANUAL takes `lines`' })
    @IsIn(['AUTO', 'MANUAL'])
    allocation: 'AUTO' | 'MANUAL';

    @ApiPropertyOptional({ type: [EcDepositLineDto] })
    @ValidateIf((o: RecordEcDepositDto) => o.allocation === 'MANUAL')
    @IsArray()
    @ArrayMaxSize(100)
    @ValidateNested({ each: true })
    @Type(() => EcDepositLineDto)
    lines?: EcDepositLineDto[];

    @ApiProperty({ enum: EC_PAYMENT_METHODS })
    @IsIn(EC_PAYMENT_METHODS)
    payment_method: EcPaymentMethod;

    @ApiPropertyOptional({ description: 'The day it was paid (from the bank stamp). Default today. YYYY-MM-DD.' })
    @IsOptional()
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'deposit_date must be YYYY-MM-DD' })
    deposit_date?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    reference_number?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    bank_name?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(500)
    remarks?: string;
}

export class ReverseEcDepositDto {
    @ApiProperty({ description: 'Why the payment is being reversed (kept in the activity log)' })
    @IsString()
    @MinLength(3)
    @MaxLength(500)
    reason: string;
}
