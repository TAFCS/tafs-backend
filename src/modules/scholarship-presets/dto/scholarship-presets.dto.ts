import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateScholarshipPresetDto {
    @IsString()
    @MaxLength(255)
    title: string;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @IsOptional()
    @IsBoolean()
    is_active?: boolean;
}

export class UpdateScholarshipPresetDto {
    @IsOptional()
    @IsString()
    @MaxLength(255)
    title?: string;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @IsOptional()
    @IsBoolean()
    is_active?: boolean;
}
