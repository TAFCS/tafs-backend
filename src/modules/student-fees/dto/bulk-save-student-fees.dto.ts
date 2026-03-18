import { IsArray, ValidateNested, IsNumber, IsString, IsOptional, IsPositive } from 'class-validator';
import { Type } from 'class-transformer';

export class SaveStudentFeeItemDto {
    @IsNumber()
    fee_type_id: number;

    @IsNumber()
    month: number;

    @IsNumber()
    target_month: number;

    @IsString()
    academic_year: string;

    /** Gross price for this fee before any discount is applied. */
    @IsNumber({ maxDecimalPlaces: 2 })
    @IsPositive()
    amount_before_discount: number;
}

export class BulkSaveStudentFeesDto {
    @IsNumber()
    student_id: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SaveStudentFeeItemDto)
    items: SaveStudentFeeItemDto[];
}
