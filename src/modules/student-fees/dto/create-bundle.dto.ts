import { IsString, IsInt, IsOptional, IsArray, IsNotEmpty, IsDecimal, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class FeeDateOverride {
    @IsInt()
    id: number;

    @IsString()
    fee_date: string;
}

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

    /** Per-fee date overrides. Applied atomically in the same transaction as bundle creation. */
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => FeeDateOverride)
    fee_date_overrides?: FeeDateOverride[];
}
