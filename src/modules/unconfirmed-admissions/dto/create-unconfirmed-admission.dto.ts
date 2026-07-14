import {
  IsString,
  IsNotEmpty,
  IsDateString,
  IsOptional,
  IsInt,
  IsNumber,
  Min,
  Matches,
  IsArray,
  ValidateNested,
  MaxLength,
  Allow,
} from 'class-validator';
import { Type } from 'class-transformer';

export class GuardianDetailDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  relation: string;

  @IsString()
  @IsOptional()
  @Matches(/^[0-9]{5}-[0-9]{7}-[0-9]$/, {
    message: 'CNIC must follow the format 12345-1234567-1',
  })
  cnic?: string;
}

export class CreateUnconfirmedAdmissionDto {
  @IsString()
  @IsNotEmpty()
  full_name: string;

  @IsDateString()
  @IsNotEmpty()
  date_of_birth: string;

  @IsString()
  @IsNotEmpty()
  gender: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsInt()
  @IsOptional()
  campus_id?: number;

  @IsNumber()
  @Min(0)
  @IsNotEmpty()
  deposit_amount: number;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => GuardianDetailDto)
  guardians?: GuardianDetailDto[];

  @Allow()
  @IsOptional()
  academic_system?: any;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  requested_grade?: string;

  @IsString()
  @IsOptional()
  admin_notes?: string;
}
