import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/** "1,2,3" or ["1","2"] → [1, 2, 3]. Empty means "all". */
const toIntArray = ({ value }: { value: unknown }) => {
  if (value == null || value === '') return undefined;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const ids = parts.map((v) => Number(String(v).trim())).filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? ids : undefined;
};
const toStringArray = ({ value }: { value: unknown }) => {
  if (value == null || value === '') return undefined;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const out = parts.map((v) => String(v).trim()).filter(Boolean);
  return out.length ? out : undefined;
};
const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1' ? true : value === false || value === 'false' || value === '0' ? false : value;

export class CreateDocumentTypeDto {
  @ApiProperty({ example: 'Vaccination card' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'VACCINATION_CARD' })
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/, { message: 'code must be capital letters, digits and underscores' })
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiPropertyOptional({ enum: ['STUDENT', 'GUARDIAN'] })
  @IsOptional()
  @IsIn(['STUDENT', 'GUARDIAN'])
  owner?: 'STUDENT' | 'GUARDIAN';

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allow_multiple?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required_at_admission?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  restricted?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  display_order?: number;
}

/** Owner, origin and code are fixed once a type exists. */
export class UpdateDocumentTypeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allow_multiple?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required_at_admission?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  restricted?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  display_order?: number;
}

/** Multipart fields that travel with the files. */
export class UploadDocumentDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  type_id: number;

  /** Set for a parent's document (CNIC, passport). */
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  guardian_id?: number;

  /** Set to add a version to this document (a clearer copy). */
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  document_id?: number;

  @ApiPropertyOptional({ example: 'Term 1 2026-27' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  title?: string;

  @ApiPropertyOptional({ example: '2026-27' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  academic_year?: string;

  @ApiPropertyOptional({ example: 'Clearer copy brought by the father' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ArchiveDocumentDto {
  @ApiProperty({ example: 'Uploaded on the wrong student' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

/** The student the caller has open, so a parent's document is logged against that child. */
export class ContextQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cc?: number;
}

export class LinkQueryDto extends ContextQueryDto {
  @ApiPropertyOptional({ enum: ['inline', 'attachment'] })
  @IsOptional()
  @IsIn(['inline', 'attachment'])
  disposition?: 'inline' | 'attachment';
}

export class SummaryQueryDto {
  @ApiProperty({ example: '101,102,103' })
  @Transform(toIntArray)
  @IsArray()
  @IsInt({ each: true })
  ccs: number[];
}

export class MissingQueryDto {
  @ApiPropertyOptional({ description: 'Name, GR or CC' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ example: '1,2' })
  @IsOptional()
  @Transform(toIntArray)
  @IsArray()
  @IsInt({ each: true })
  campus_ids?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toIntArray)
  @IsArray()
  @IsInt({ each: true })
  class_ids?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toIntArray)
  @IsArray()
  @IsInt({ each: true })
  section_ids?: number[];

  /** Only students missing at least one of these types. Empty means any required type. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toIntArray)
  @IsArray()
  @IsInt({ each: true })
  type_ids?: number[];

  @ApiPropertyOptional({ example: 'ENROLLED,SOFT_ADMISSION' })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsIn(['ENROLLED', 'SOFT_ADMISSION', 'QUICK_ADMISSION', 'LEFT', 'GRADUATED', 'EXPELLED'], { each: true })
  statuses?: string[];

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  /** Export: every row, no paging. Needs the export permission. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  all?: boolean;
}

export class ActivityQueryDto {
  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  /** Return entries older than this activity id. */
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  before?: number;
}
