import { IsArray, ValidateNested, IsNumber, IsString, IsOptional, IsDecimal } from 'class-validator';
import { Type } from 'class-transformer';

export class SaveStudentFeeItemDto {
    @IsNumber()
    fee_type_id: number;

    @IsNumber()
    amount: number;

    @IsNumber()
    @IsOptional()
    month?: number;

    @IsString()
    academic_year: string;
}

export class BulkSaveStudentFeesDto {
    @IsNumber()
    student_id: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SaveStudentFeeItemDto)
    items: SaveStudentFeeItemDto[];
}
