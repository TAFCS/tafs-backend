import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, Max, Min, ValidateIf } from 'class-validator';

export class ApplyScholarshipDto {
    @IsInt()
    @IsPositive()
    student_id: number;

    @IsString()
    @IsNotEmpty()
    academic_year: string;

    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    @Max(100)
    scholarship_percentage: number;

    @IsOptional()
    @IsInt()
    @IsPositive()
    scholarship_type_id?: number;

    // Required only when scholarship_type_id is not provided.
    @ValidateIf((o) => o.scholarship_type_id === undefined || o.scholarship_type_id === null)
    @IsString()
    @IsNotEmpty({ message: 'custom_title is required when scholarship_type_id is not provided' })
    custom_title?: string;
}
