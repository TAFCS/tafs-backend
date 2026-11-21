import { IsArray, IsInt, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class CampusUpdateItemDto {
    @IsOptional()
    @IsInt()
    id?: number;

    @IsOptional()
    @IsString()
    @MaxLength(10)
    campus_code?: string;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    campus_name?: string;

    @IsOptional()
    @IsString()
    address?: string;

    /** TAFSD-549: the campus's UAN phone number, e.g. "111-823-723". Empty clears it. */
    @IsOptional()
    @IsString()
    @MaxLength(40)
    uan_number?: string;

    @IsOptional()
    @IsString()
    @MaxLength(10)
    campus_prefix?: string;
}

export class BulkUpdateCampusesDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CampusUpdateItemDto)
    items: CampusUpdateItemDto[];
}
