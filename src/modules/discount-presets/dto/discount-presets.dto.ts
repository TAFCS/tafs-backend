import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateDiscountPresetDto {
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

export class UpdateDiscountPresetDto {
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
