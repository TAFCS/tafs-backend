import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateBulkVouchersDto {
    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    campus_id: number;

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    class_id?: number;

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    section_id?: number;

    @IsString()
    @IsNotEmpty()
    academic_year: string;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(12)
    month: number;

    @IsISO8601()
    @IsNotEmpty()
    issue_date: string;

    @IsISO8601()
    @IsNotEmpty()
    due_date: string;

    @IsISO8601()
    @IsOptional()
    validity_date?: string;

    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    bank_account_id: number;

    @IsBoolean()
    @IsOptional()
    late_fee_charge?: boolean;

    @Type(() => Number)
    @IsNumber()
    @IsOptional()
    late_fee_amount?: number;
}
