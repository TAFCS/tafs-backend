import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsEnum,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import { ec_fee_frequency } from '@prisma/client';
import { toUpperStringArray } from '../../ec-common.util';

export const EC_FEE_HEAD_STATES = ['ACTIVE', 'INACTIVE'] as const;
export type EcFeeHeadState = (typeof EC_FEE_HEAD_STATES)[number];

export class EcFeeHeadListQueryDto {
    @ApiPropertyOptional({ description: 'Part of the head name' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    q?: string;

    @ApiPropertyOptional({ enum: ec_fee_frequency, isArray: true, description: 'Empty means both' })
    @IsOptional()
    @Transform(toUpperStringArray)
    @IsEnum(ec_fee_frequency, { each: true })
    frequencies?: ec_fee_frequency[];

    @ApiPropertyOptional({ enum: EC_FEE_HEAD_STATES, isArray: true, description: 'Empty means both' })
    @IsOptional()
    @Transform(toUpperStringArray)
    @IsIn(EC_FEE_HEAD_STATES, { each: true })
    states?: EcFeeHeadState[];
}

export class EcFeeHeadSearchQueryDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    q?: string;
}

export class CreateEcFeeHeadDto {
    @ApiProperty({ example: 'SCOUTS REGISTRATION' })
    @IsString()
    @MinLength(2)
    @MaxLength(100)
    name: string;

    @ApiProperty({ enum: ec_fee_frequency })
    @IsEnum(ec_fee_frequency)
    frequency: ec_fee_frequency;

    @ApiProperty({ type: [Number], description: 'Calendar months 1-12. A ONE_TIME head takes exactly one.' })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(12)
    @Type(() => Number)
    @IsInt({ each: true })
    @Min(1, { each: true })
    @Max(12, { each: true })
    months: number[];

    @ApiPropertyOptional()
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(9999)
    sort_order?: number;
}

export class UpdateEcFeeHeadDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MinLength(2)
    @MaxLength(100)
    name?: string;

    @ApiPropertyOptional({ enum: ec_fee_frequency })
    @IsOptional()
    @IsEnum(ec_fee_frequency)
    frequency?: ec_fee_frequency;

    @ApiPropertyOptional({ type: [Number] })
    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(12)
    @Type(() => Number)
    @IsInt({ each: true })
    @Min(1, { each: true })
    @Max(12, { each: true })
    months?: number[];

    @ApiPropertyOptional()
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(9999)
    sort_order?: number;

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    is_active?: boolean;
}
