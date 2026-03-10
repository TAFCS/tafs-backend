import { IsBoolean, IsInt, IsISO8601, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateVoucherDto {
    @IsInt()
    @IsNotEmpty()
    student_id: number;

    @IsInt()
    @IsNotEmpty()
    campus_id: number;

    @IsInt()
    @IsNotEmpty()
    class_id: number;

    @IsInt()
    @IsOptional()
    section_id?: number;

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

    @IsBoolean()
    @IsNotEmpty()
    late_fee_charge: boolean;
}
