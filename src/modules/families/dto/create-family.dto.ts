import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsBoolean,
  MinLength,
} from 'class-validator';

export class CreateFamilyDto {
  @IsString()
  @IsNotEmpty()
  household_name: string;

  @IsOptional()
  @IsString()
  primary_address?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  /** Plain-text password — service will bcrypt-hash it */
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsString()
  legacy_pid?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsBoolean()
  consent_publicity?: boolean;
}
