import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';

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
}
