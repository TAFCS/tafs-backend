import { IsString, IsOptional, MaxLength } from 'class-validator';

export class UpdateFamilyAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  house_appt_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  area_block?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postal_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  province?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  work_phone?: string; // Mapped to Home Phone #

  @IsOptional()
  bulk_sync?: boolean;
}
