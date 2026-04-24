import { IsInt, IsString, IsDecimal, IsArray, ValidateNested, IsNumber, Min, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class InstallmentScheduleItemDto {
    @IsInt()
    target_month: number;

    @IsString()
    fee_date: string; // ISO string

    @IsNumber()
    amount: number;
}

export class CreateInstallmentDto {
    @IsInt()
    student_id: number;

    @IsInt()
    fee_type_id: number;

    @IsString()
    academic_year: string;

    @IsNumber()
    total_amount: number;

    @IsInt()
    @Min(1)
    installment_count: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => InstallmentScheduleItemDto)
    schedule: InstallmentScheduleItemDto[];

    @IsArray()
    @IsOptional()
    merge_targets: {
        index: number;
        existing_head_id: number;
    }[];
}
