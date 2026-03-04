import {
  IsString,
  IsOptional,
  IsEmail,
  IsBoolean,
  MinLength,
} from 'class-validator';

export class UpdateFamilyDto {
  @IsOptional()
  @IsString()
  household_name?: string;

  @IsOptional()
  @IsString()
  primary_address?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsBoolean()
  consent_publicity?: boolean;

  @IsOptional()
  @IsString()
  legacy_pid?: string;
}
