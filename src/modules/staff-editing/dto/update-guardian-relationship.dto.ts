import { IsOptional, IsString, IsBoolean } from 'class-validator';

export class UpdateGuardianRelationshipDto {
  @IsOptional()
  @IsString()
  relationship?: string;

  @IsOptional()
  @IsBoolean()
  is_primary_contact?: boolean;

  @IsOptional()
  @IsBoolean()
  is_emergency_contact?: boolean;
}
