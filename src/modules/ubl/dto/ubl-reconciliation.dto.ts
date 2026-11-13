import { Transform, Type } from 'class-transformer';
import { IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { toStringArray } from '../../../common/transforms/query-array.transform';
import { RECON_STATUSES } from '../ubl-reconciliation';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class UblReconciliationQueryDto {
    @IsDateString()
    @Matches(DATE_ONLY, { message: 'from_date must be YYYY-MM-DD' })
    from_date!: string;

    @IsDateString()
    @Matches(DATE_ONLY, { message: 'to_date must be YYYY-MM-DD' })
    to_date!: string;

    /** Any of the reconciliation statuses, or EXCEPTIONS for every status that needs a look. */
    @IsOptional()
    @Transform(toStringArray)
    @IsArray()
    @IsIn([...RECON_STATUSES, 'EXCEPTIONS'], { each: true })
    status?: string[];

    @IsOptional()
    @Transform(toStringArray)
    @IsArray()
    @IsString({ each: true })
    channel?: string[];

    /** Transaction id, CC, student name, consumer number, voucher or TAFS receipt. */
    @IsOptional()
    @IsString()
    @MaxLength(100)
    q?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number = 1;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number = 50;
}

export class UblSettlementPreviewDto {
    @IsOptional()
    @IsString()
    @MaxLength(100)
    sheet?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(1000)
    header_row?: number;
}

export class UblSettlementImportDto extends UblSettlementPreviewDto {
    /** JSON: {"transaction_id": "<column header>", "amount": "<column header>", ...} */
    @IsString()
    @MaxLength(5000)
    mapping!: string;
}
