import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { EC_PAYMENT_METHODS, type EcPaymentMethod } from '../../ec.constants';
import { toIntArray, toUpperStringArray } from '../../ec-common.util';

const toStringArray = ({ value }: { value: unknown }) => {
    if (value == null || value === '') return undefined;
    return (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
};
const toLowerStringArray = ({ value }: { value: unknown }) => toStringArray({ value })?.map((s) => s.toLowerCase());

/** Filters every EC report shares. Arrays are multi-select; empty means all. */
export class EcReportFilterDto {
    @ApiPropertyOptional({ type: [Number] })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    campus_ids?: number[];

    @ApiPropertyOptional({ type: [Number] })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    class_ids?: number[];

    @ApiPropertyOptional({ type: [Number] })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    section_ids?: number[];

    @ApiPropertyOptional({ type: [Number] })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    fee_head_ids?: number[];

    @ApiPropertyOptional({ type: [String] })
    @IsOptional()
    @Transform(toStringArray)
    @IsString({ each: true })
    @MaxLength(10, { each: true })
    academic_years?: string[];
}

class Paged extends EcReportFilterDto {
    @ApiPropertyOptional({ description: 'A student (name, C.C., G.R., phone) or a voucher number' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    q?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;

    @ApiPropertyOptional()
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;
}

export const EC_OUTSTANDING_STATES = ['UNPAID', 'PARTIALLY_PAID', 'EXPIRED'] as const;
export type EcOutstandingState = (typeof EC_OUTSTANDING_STATES)[number];

export class EcOutstandingQueryDto extends Paged {
    @ApiPropertyOptional({ enum: EC_OUTSTANDING_STATES, isArray: true, description: 'Empty means all three' })
    @IsOptional()
    @Transform(toUpperStringArray)
    @IsIn(EC_OUTSTANDING_STATES, { each: true })
    states?: EcOutstandingState[];
}

export class EcPaymentsQueryDto extends Paged {
    @ApiPropertyOptional({ enum: EC_PAYMENT_METHODS, isArray: true })
    @IsOptional()
    @Transform(toLowerStringArray)
    @IsIn(EC_PAYMENT_METHODS, { each: true })
    payment_methods?: EcPaymentMethod[];

    @ApiPropertyOptional({ description: 'Paid on or after (YYYY-MM-DD)' })
    @IsOptional()
    @Matches(/^\d{4}-\d{2}-\d{2}$/)
    date_from?: string;

    @ApiPropertyOptional({ description: 'Paid on or before (YYYY-MM-DD)' })
    @IsOptional()
    @Matches(/^\d{4}-\d{2}-\d{2}$/)
    date_to?: string;
}
