import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsISO8601, IsOptional, IsString } from 'class-validator';

export class FilterVouchersDto {
    @ApiPropertyOptional({ description: 'Filter by Student CC' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    student_id?: number;

    @ApiPropertyOptional({ description: 'Filter by Campus ID' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    campus_id?: number;

    @ApiPropertyOptional({ description: 'Filter by Voucher Status (e.g. UNPAID, PAID, OVERDUE)' })
    @IsOptional()
    @IsString()
    status?: string;

    @ApiPropertyOptional({ description: 'Filter by Class ID' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    class_id?: number;

    @ApiPropertyOptional({ description: 'Filter by Section ID' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    section_id?: number;

    @ApiPropertyOptional({ description: 'Filter by exact Student CC number' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    cc?: number;

    @ApiPropertyOptional({ description: 'Filter by Student GR Number' })
    @IsOptional()
    @IsString()
    gr?: string;

    @ApiPropertyOptional({ description: 'Filter by exact Voucher ID' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    id?: number;

    @ApiPropertyOptional({ description: 'Filter vouchers with fee_date on or after this date (ISO 8601, e.g. 2026-03-01)' })
    @IsOptional()
    @IsISO8601()
    date_from?: string;

    @ApiPropertyOptional({ description: 'Filter vouchers with fee_date on or before this date (ISO 8601, e.g. 2026-03-10)' })
    @IsOptional()
    @IsISO8601()
    date_to?: string;

    @ApiPropertyOptional({ description: 'Page number for pagination', default: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    page?: number = 1;

    @ApiPropertyOptional({ description: 'Number of items per page', default: 50 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    limit?: number = 50;

    @ApiPropertyOptional({ description: 'Show only vouchers whose heads all share a single fee_date' })
    @IsOptional()
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    single_fee_date?: boolean;

    @ApiPropertyOptional({ description: 'Show only vouchers with multiple fee heads' })
    @IsOptional()
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    multiple_fee_heads?: boolean;
}
