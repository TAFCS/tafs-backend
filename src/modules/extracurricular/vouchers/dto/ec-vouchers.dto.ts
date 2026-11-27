import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import { toIntArray, toUpperStringArray } from '../../ec-common.util';
import { EC_VOUCHER_STATES, type EcVoucherState } from '../../ec-voucher-state';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toStringArray = ({ value }: { value: unknown }) => {
    if (value == null || value === '') return undefined;
    return (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
};

/** Filters every EC voucher list shares. Arrays are multi-select; empty means all. */
export class EcVoucherFilterDto {
    @ApiPropertyOptional({ description: 'Voucher number (with or without EC), or a student C.C. / G.R. / name / phone' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    q?: string;

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

    @ApiPropertyOptional({ type: [Number], description: 'Vouchers carrying any of these heads' })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    fee_head_ids?: number[];

    @ApiPropertyOptional({ enum: EC_VOUCHER_STATES, isArray: true })
    @IsOptional()
    @Transform(toUpperStringArray)
    @IsIn(EC_VOUCHER_STATES, { each: true })
    states?: EcVoucherState[];

    @ApiPropertyOptional({ type: [String] })
    @IsOptional()
    @Transform(toStringArray)
    @IsString({ each: true })
    @MaxLength(10, { each: true })
    academic_years?: string[];

    @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
    @IsOptional()
    @Matches(DATE)
    issue_from?: string;

    @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
    @IsOptional()
    @Matches(DATE)
    issue_to?: string;

    @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
    @IsOptional()
    @Matches(DATE)
    expiry_from?: string;

    @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
    @IsOptional()
    @Matches(DATE)
    expiry_to?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    student_id?: number;

    @ApiPropertyOptional({ description: 'Vouchers issued by one bulk run' })
    @IsOptional()
    @IsString()
    @MaxLength(36)
    bulk_run_id?: string;
}

export class EcVoucherListQueryDto extends EcVoucherFilterDto {
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

export class EcVoucherSearchQueryDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    q?: string;

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
}

export class EcIssuableQueryDto {
    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    student_id: number;
}

export class CreateEcVoucherDto {
    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    student_id: number;

    @ApiProperty({ type: [Number], description: 'Unissued charges of one academic year' })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(60)
    @Type(() => Number)
    @IsInt({ each: true })
    charge_ids: number[];

    @ApiProperty({ example: '2026-11-27' })
    @Matches(DATE, { message: 'issue_date must be YYYY-MM-DD' })
    issue_date: string;

    @ApiPropertyOptional({ example: '2026-12-12', description: 'Valid through this day. Default: 15 days after the issue date.' })
    @IsOptional()
    @Matches(DATE, { message: 'expiry_date must be YYYY-MM-DD' })
    expiry_date?: string;

    @ApiPropertyOptional({ description: 'Default: the default active bank account' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    bank_account_id?: number;
}

export class EcPdfPrepareDto {
    @ApiProperty({ type: [Number] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(25)
    @Type(() => Number)
    @IsInt({ each: true })
    ids: number[];
}

export class EcPdfMergeDto {
    @ApiProperty({ type: [Number] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(500)
    @Type(() => Number)
    @IsInt({ each: true })
    ids: number[];
}
