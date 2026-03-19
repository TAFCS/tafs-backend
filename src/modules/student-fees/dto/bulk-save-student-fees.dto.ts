import { IsArray, ValidateNested, IsNumber, IsString, IsOptional, IsPositive } from 'class-validator';
import { Type } from 'class-transformer';

export class SaveStudentFeeItemDto {
    @IsNumber()
    fee_type_id: number;

    @IsNumber()
    @IsOptional()
    month?: number;

    @IsNumber()
    @IsOptional()
    target_month?: number;

    @IsString()
    academic_year: string;

     /** Gross price for this fee before any student-specific discount is applied (template price). */
    @IsNumber({ maxDecimalPlaces: 2 })
    @IsPositive()
    amount_before_discount: number;

    /** Net amount for this student (after specific override). */
    @IsNumber({ maxDecimalPlaces: 2 })
    @IsPositive()
    @IsOptional()
    amount?: number;
}

export class BulkSaveStudentFeesDto {
    @IsNumber()
    student_id: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SaveStudentFeeItemDto)
    items: SaveStudentFeeItemDto[];
}
