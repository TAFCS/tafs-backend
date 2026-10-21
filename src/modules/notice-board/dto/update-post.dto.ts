import { IsString, IsOptional, IsBoolean, IsDateString, IsArray } from 'class-validator';

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsBoolean()
  is_pinned?: boolean;

  @IsOptional()
  @IsDateString()
  expires_at?: string;

  /** TAFSD-405: the full attachment list after the edit (send both or neither). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  media_urls?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  media_types?: string[];
}
