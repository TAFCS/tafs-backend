import { IsBoolean, IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CreateVoucherDto {
    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    student_id: number;

    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    campus_id: number;

    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    class_id: number;

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    section_id?: number;

    @Type(() => Number)
    @IsInt()
    @IsNotEmpty()
    bank_account_id: number;

    @IsISO8601()
    @IsNotEmpty()
    issue_date: string;

    @IsISO8601()
    @IsNotEmpty()
    due_date: string;

    @IsISO8601()
    @IsOptional()
    validity_date?: string;

    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    @IsNotEmpty()
    late_fee_charge: boolean;

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    precedence?: number;

    @Type(() => Number)
    @IsInt({ each: true })
    @IsOptional()
    orderedFeeIds?: number[];

    @IsString()
    @IsOptional()
    academic_year?: string;

    @Type(() => Number)
    @IsInt()
    @IsOptional()
    month?: number;
}
