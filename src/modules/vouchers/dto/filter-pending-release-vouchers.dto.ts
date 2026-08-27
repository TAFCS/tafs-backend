import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';

export class FilterPendingReleaseVouchersDto {
    @ApiPropertyOptional({ description: 'Filter by Campus ID(s), comma-separated for multiple' })
    @IsOptional()
    @IsString()
    campus_id?: string;

    @ApiPropertyOptional({ description: 'Filter by Class ID(s), comma-separated for multiple' })
    @IsOptional()
    @IsString()
    class_id?: string;

    @ApiPropertyOptional({ description: 'Filter by the bulk job that created the voucher' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    bulk_voucher_job_id?: number;

    @ApiPropertyOptional({ description: 'Filter by exact Student CC number' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    cc?: number;

    @ApiPropertyOptional({ description: 'Filter by Student GR Number' })
    @IsOptional()
    @IsString()
    gr?: string;

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
}
