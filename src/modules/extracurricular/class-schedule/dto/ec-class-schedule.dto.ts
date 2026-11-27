import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { EC_SCHEDULE_MAX_CELLS } from '../../ec.constants';
import { toIntArray } from '../../ec-common.util';

export class EcClassScheduleQueryDto {
    @ApiProperty({ example: '2026-2027', description: 'The year being edited' })
    @IsString()
    @MaxLength(10)
    academic_year: string;

    @ApiPropertyOptional({ type: [Number], description: 'Rows for these campuses plus the all-campus rows. Empty means all.' })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    campus_ids?: number[];

    @ApiPropertyOptional({ type: [Number], description: 'Empty means all' })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    class_ids?: number[];

    @ApiPropertyOptional({ type: [Number], description: 'Empty means all' })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    fee_head_ids?: number[];
}

export class EcClassScheduleCellDto {
    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    class_id: number;

    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    fee_head_id: number;

    @ApiProperty({ nullable: true, description: 'null = every campus' })
    @ValidateIf((_, v) => v !== null)
    @Type(() => Number)
    @IsInt()
    campus_id: number | null;

    @ApiProperty({ nullable: true, description: 'Whole rupees; null clears the cell' })
    @ValidateIf((_, v) => v !== null)
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(10_000_000)
    amount: number | null;
}

export class UpsertEcClassScheduleDto {
    @ApiProperty({ example: '2026-2027' })
    @IsString()
    @MaxLength(10)
    academic_year: string;

    @ApiProperty({ type: [EcClassScheduleCellDto] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(EC_SCHEDULE_MAX_CELLS)
    @ValidateNested({ each: true })
    @Type(() => EcClassScheduleCellDto)
    cells: EcClassScheduleCellDto[];
}

export class CopyEcClassScheduleDto {
    @ApiProperty({ example: '2025-2026' })
    @IsString()
    @MaxLength(10)
    from_year: string;

    @ApiProperty({ example: '2026-2027' })
    @IsString()
    @MaxLength(10)
    to_year: string;

    @ApiPropertyOptional({ description: 'Replace amounts already set in the target year. Default: keep them.' })
    @IsOptional()
    @IsBoolean()
    overwrite?: boolean;
}
