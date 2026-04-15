import { IsNumber, IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class LinkExistingGuardianDto {
  @IsNumber()
  @IsNotEmpty()
  guardian_id: number;

  @IsString()
  @IsNotEmpty()
  relationship: string;

  @IsOptional()
  @IsBoolean()
  is_primary_contact?: boolean;

  @IsOptional()
  @IsBoolean()
  is_emergency_contact?: boolean;
}
