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
    Max,
    MaxLength,
    Min,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { toIntArray } from '../../ec-common.util';

export const EC_AMOUNT_SOURCES = ['SCHEDULE', 'CUSTOM'] as const;
export type EcAmountSource = (typeof EC_AMOUNT_SOURCES)[number];

/** At most this many students in one bulk assign/remove. */
export const EC_BULK_CHARGE_MAX_STUDENTS = 5000;

const toStringArray = ({ value }: { value: unknown }) => {
    if (value == null || value === '') return undefined;
    return (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
};

export class EcStudentChargesQueryDto {
    @ApiPropertyOptional({ type: [String], description: 'Academic years. Empty means every year.' })
    @IsOptional()
    @Transform(toStringArray)
    @IsString({ each: true })
    @MaxLength(10, { each: true })
    academic_years?: string[];
}

export class EcClassAmountsQueryDto {
    @ApiProperty({ example: '2026-2027' })
    @IsString()
    @MaxLength(10)
    academic_year: string;
}

export class EcChargeCellDto {
    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    fee_head_id: number;

    @ApiProperty({ description: 'Calendar month 1-12' })
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(12)
    target_month: number;

    @ApiProperty({ nullable: true, description: 'Whole rupees; null removes the charge (only while it is not on a voucher)' })
    @ValidateIf((_, v) => v !== null)
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(10_000_000)
    amount: number | null;

    @ApiPropertyOptional({ enum: EC_AMOUNT_SOURCES, description: 'Where a new charge\'s amount came from. Default CUSTOM.' })
    @IsOptional()
    @IsIn(EC_AMOUNT_SOURCES)
    source?: EcAmountSource;
}

export class SaveEcStudentChargesDto {
    @ApiProperty({ example: '2026-2027' })
    @IsString()
    @MaxLength(10)
    academic_year: string;

    @ApiProperty({ type: [EcChargeCellDto] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(240)
    @ValidateNested({ each: true })
    @Type(() => EcChargeCellDto)
    cells: EcChargeCellDto[];
}

/** Which students a bulk operation reaches: explicit C.C.s and/or placement filters, within scope. */
export class EcBulkTargetDto {
    @ApiPropertyOptional({ type: [Number] })
    @IsOptional()
    @Transform(toIntArray)
    @IsArray()
    @ArrayMaxSize(EC_BULK_CHARGE_MAX_STUDENTS)
    @IsInt({ each: true })
    student_ids?: number[];

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

export class EcBulkAssignDto extends EcBulkTargetDto {
    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    fee_head_id: number;

    @ApiProperty({ example: '2026-2027' })
    @IsString()
    @MaxLength(10)
    academic_year: string;

    @ApiPropertyOptional({ type: [Number], description: "A subset of the head's months. Empty means all of them." })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(12)
    @Type(() => Number)
    @IsInt({ each: true })
    @Min(1, { each: true })
    @Max(12, { each: true })
    months?: number[];

    @ApiProperty({ enum: EC_AMOUNT_SOURCES, description: 'SCHEDULE: each student\'s class amount. CUSTOM: one amount for everyone.' })
    @IsIn(EC_AMOUNT_SOURCES)
    amount_source: EcAmountSource;

    @ApiPropertyOptional({ description: 'Whole rupees; required for CUSTOM' })
    @ValidateIf((o: EcBulkAssignDto) => o.amount_source === 'CUSTOM')
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(10_000_000)
    amount?: number;
}

export class EcBulkRemoveDto extends EcBulkTargetDto {
    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    fee_head_id: number;

    @ApiProperty({ example: '2026-2027' })
    @IsString()
    @MaxLength(10)
    academic_year: string;

    @ApiPropertyOptional({ type: [Number], description: 'Empty means every month' })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(12)
    @Type(() => Number)
    @IsInt({ each: true })
    @Min(1, { each: true })
    @Max(12, { each: true })
    months?: number[];
}
