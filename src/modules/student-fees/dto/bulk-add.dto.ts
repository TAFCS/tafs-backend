import { IsString, IsInt, IsNumber, IsArray, IsISO8601, Min, Max, IsNotEmpty } from 'class-validator';

export class BulkAddDto {
    @IsString()
    @IsNotEmpty()
    academic_year: string;

    @IsInt()
    fee_type_id: number;

    @IsInt()
    @Min(1)
    @Max(12)
    month: number; // Sets the target_month column

    @IsISO8601()
    fee_date: string; // Sets the fee_date column — independent from month

    @IsNumber({ maxDecimalPlaces: 2 })
    amount: number; // Used for both amount and amount_before_discount

    @IsArray()
    @IsInt({ each: true })
    student_ids: number[];
}
