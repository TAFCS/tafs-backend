import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { UAN_FORMAT } from './uan-format';

export class CreateCampusDto {
    @IsString()
    @MaxLength(10)
    campus_code: string;

    @IsString()
    @MaxLength(100)
    campus_name: string;

    @IsOptional()
    @IsString()
    address?: string;

    /** TAFSD-549: the campus's UAN phone number, written 111-XXX-XXX (e.g. 111-823-723). Empty clears it. */
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @Matches(UAN_FORMAT, { message: 'UAN number must be written as 111-XXX-XXX' })
    uan_number?: string;

    /** HR employee code prefix (e.g. GEJ). Not used for student G.R. numbers. */
    @IsOptional()
    @IsString()
    @MaxLength(10)
    campus_prefix?: string;
}
