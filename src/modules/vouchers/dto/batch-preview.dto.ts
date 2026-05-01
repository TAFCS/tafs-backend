import { Type } from 'class-transformer';
import {
    IsInt,
    IsISO8601,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsArray,
    IsEnum,
} from 'class-validator';

export class BatchPreviewDto {
    @Type(() => Number)
    @IsInt({ each: true })
    @IsOptional()
    campus_ids?: number[];

    @Type(() => Number)
    @IsInt({ each: true })
    @IsOptional()
    class_ids?: number[];

    @Type(() => Number)
    @IsInt({ each: true })
    @IsOptional()
    section_ids?: number[];

    @IsISO8601()
    @IsNotEmpty()
    fee_date_from: string;

    @IsISO8601()
    @IsNotEmpty()
    fee_date_to: string;

    @IsString()
    @IsOptional()
    academic_year?: string;

    @IsArray()
    @IsOptional()
    @IsString({ each: true })
    include_statuses?: string[]; // default: ['NOT_ISSUED']
}
