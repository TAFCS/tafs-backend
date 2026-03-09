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
}
