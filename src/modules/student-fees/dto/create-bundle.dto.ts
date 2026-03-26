import { IsString, IsInt, IsOptional, IsArray, IsNotEmpty, IsDecimal } from 'class-validator';

export class CreateBundleDto {
    @IsInt()
    @IsNotEmpty()
    student_id: number;

    @IsString()
    @IsNotEmpty()
    bundle_name: string;

    @IsOptional()
    @IsDecimal()
    total_amount?: string;

    @IsString()
    @IsOptional()
    academic_year?: string;

    @IsArray()
    @IsInt({ each: true })
    @IsNotEmpty()
    fee_ids: number[];

    @IsInt()
    @IsOptional()
    target_month?: number;
}
