import { IsArray, IsInt, IsNotEmpty } from 'class-validator';

export class BulkDeleteDto {
    @IsArray()
    @IsInt({ each: true })
    @IsNotEmpty()
    student_fee_ids: number[];
}
