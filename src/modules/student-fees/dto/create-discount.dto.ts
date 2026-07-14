import { IsInt, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, Max, Min, ValidateIf } from 'class-validator';

export class CreateDiscountDto {
    @IsInt()
    @IsPositive()
    student_id: number;

    @IsOptional()
    @IsInt()
    @IsPositive()
    discount_type_id?: number;

    // Required only when discount_type_id is not provided — enforced here since
    // class-validator can't express "at least one of these two fields" any simpler.
    @ValidateIf((o) => o.discount_type_id === undefined || o.discount_type_id === null)
    @IsString()
    @IsNotEmpty({ message: 'custom_title is required when discount_type_id is not provided' })
    custom_title?: string;

    @IsNumber({ maxDecimalPlaces: 2 })
    @IsPositive()
    amount: number;

    @IsOptional()
    @IsISO8601({ strict: true }, { message: 'fee_date must be a valid date in YYYY-MM-DD format' })
    fee_date?: string;

    @IsInt()
    @Min(1)
    @Max(12)
    target_month: number;

    @IsString()
    @IsNotEmpty()
    academic_year: string;
}
