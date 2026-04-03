import { IsString, IsInt, IsNumber, IsArray, Min, Max, IsNotEmpty } from 'class-validator';

export class BulkAddRangeDto {
    @IsString()
    @IsNotEmpty()
    academic_year: string;

    @IsInt()
    fee_type_id: number;

    @IsInt()
    @Min(1)
    @Max(12)
    start_month: number;

    @IsInt()
    @Min(1)
    @Max(12)
    end_month: number;

    @IsInt()
    @Min(1)
    @Max(31)
    day: number; // Applied to every month — months where day is invalid are skipped

    @IsNumber({ maxDecimalPlaces: 2 })
    amount: number;

    @IsArray()
    @IsInt({ each: true })
    student_ids: number[];
}
