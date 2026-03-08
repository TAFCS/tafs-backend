import { IsArray, IsInt, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class CampusUpdateItemDto {
    @IsInt()
    id: number;

    @IsOptional()
    @IsString()
    @MaxLength(10)
    campus_code?: string;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    campus_name?: string;
}

export class BulkUpdateCampusesDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CampusUpdateItemDto)
    items: CampusUpdateItemDto[];
}
