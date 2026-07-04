import {
  IsString,
  IsOptional,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePostDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsString()
  body: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  campus_ids?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  class_ids?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  section_ids?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  student_ccs?: number[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  media_urls?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  media_types?: string[];

  @IsOptional()
  @IsBoolean()
  is_pinned?: boolean;

  @IsOptional()
  @IsBoolean()
  notification_only?: boolean;

  @IsOptional()
  @IsDateString()
  expires_at?: string;
}
