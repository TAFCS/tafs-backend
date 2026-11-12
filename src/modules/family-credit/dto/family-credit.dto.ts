import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    IsBoolean,
    IsIn,
    IsInt,
    IsNumber,
    IsOptional,
    IsPositive,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import { REFUND_METHODS } from '../../vouchers/family-credit';
import type { RefundMethod } from '../../vouchers/family-credit';

/** `campus_ids=1,2` or `campus_ids=1&campus_ids=2` both arrive as [1, 2]. */
const toIntArray = ({ value }: { value: unknown }) => {
    if (value == null || value === '') return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
    return parts.map((p) => p.trim()).filter(Boolean).map(Number);
};

export class FamilyCreditListQueryDto {
    @ApiPropertyOptional({ description: 'Family number, family name, legacy id, or a student C.C. / G.R. / name' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    q?: string;

    @ApiPropertyOptional({ type: [Number], description: 'Families with a student on any of these campuses. Empty means all.' })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    campus_ids?: number[];

    @ApiPropertyOptional({ description: 'Also list families whose credit is back to zero.' })
    @IsOptional()
    @Transform(({ value }) => value === true || value === 'true' || value === '1')
    @IsBoolean()
    include_zero?: boolean;

    @ApiPropertyOptional({ enum: ['balance', 'last_movement', 'family'] })
    @IsOptional()
    @IsIn(['balance', 'last_movement', 'family'])
    sort_by?: 'balance' | 'last_movement' | 'family';

    @ApiPropertyOptional({ enum: ['asc', 'desc'] })
    @IsOptional()
    @IsIn(['asc', 'desc'])
    sort_dir?: 'asc' | 'desc';

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

export class FamilyCreditSearchQueryDto {
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
}

export class FamilyCreditAdjustDto {
    @ApiProperty({ example: 5000 })
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @IsPositive()
    @Max(100_000_000)
    amount!: number;

    @ApiProperty({ example: 'Opening balance carried over from the old system' })
    @IsString()
    @MinLength(3)
    @MaxLength(500)
    reason!: string;
}

export class FamilyCreditRefundDto extends FamilyCreditAdjustDto {
    @ApiProperty({ enum: REFUND_METHODS })
    @IsIn(REFUND_METHODS as unknown as string[])
    method!: RefundMethod;
}

export class FamilyCreditTransferDto extends FamilyCreditAdjustDto {
    @ApiProperty({ description: 'The family receiving the credit' })
    @Type(() => Number)
    @IsInt()
    @Min(1)
    to_family_id!: number;
}

export class FamilyCreditUndoDto {
    @ApiProperty()
    @IsString()
    @MinLength(3)
    @MaxLength(500)
    reason!: string;
}
