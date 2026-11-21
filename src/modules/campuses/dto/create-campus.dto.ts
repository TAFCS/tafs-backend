import { IsOptional, IsString, MaxLength } from 'class-validator';

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

    /** TAFSD-549: the campus's UAN phone number, e.g. "111-823-723". Empty clears it. */
    @IsOptional()
    @IsString()
    @MaxLength(40)
    uan_number?: string;

    /** HR employee code prefix (e.g. GEJ). Not used for student G.R. numbers. */
    @IsOptional()
    @IsString()
    @MaxLength(10)
    campus_prefix?: string;
}
