import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString } from 'class-validator';

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
}
