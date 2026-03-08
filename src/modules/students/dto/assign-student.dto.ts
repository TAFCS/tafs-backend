import { IsOptional, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class AssignStudentDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    campus_id?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    class_id?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    section_id?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    house_id?: number;
}
