import { IsArray, IsInt, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { UAN_FORMAT } from './uan-format';

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

    /** TAFSD-549: the campus's UAN phone number, written 111-XXX-XXX (e.g. 111-823-723). Empty clears it. */
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @Matches(UAN_FORMAT, { message: 'UAN number must be written as 111-XXX-XXX' })
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
