import { IsOptional, IsString } from 'class-validator';

export class UpdateSectionDto {
  @IsOptional()
  @IsString()
  description?: string;
}

