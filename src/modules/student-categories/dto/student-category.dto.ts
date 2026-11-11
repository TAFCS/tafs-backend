import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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

/** TAFSD-475: chip colours the webapp knows. */
export const CATEGORY_TONES = [
  'amber',
  'orange',
  'emerald',
  'sky',
  'violet',
  'rose',
  'teal',
  'slate',
] as const;

export class CreateStudentCategoryDto {
  @ApiProperty({ example: 'Staff Child' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  label: string;

  /** Fixed once created. Derived from the label when omitted (Staff Child → STAFF_CHILD). */
  @ApiPropertyOptional({ example: 'STAFF_CHILD' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/, {
    message: 'code must be capital letters, digits and underscores',
  })
  code?: string;

  @ApiPropertyOptional({ example: 'Everything waived' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiPropertyOptional({ enum: CATEGORY_TONES })
  @IsOptional()
  @IsIn(CATEGORY_TONES as unknown as string[])
  tone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  display_order?: number;
}

export class UpdateStudentCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiPropertyOptional({ enum: CATEGORY_TONES })
  @IsOptional()
  @IsIn(CATEGORY_TONES as unknown as string[])
  tone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  display_order?: number;

  /** false retires it: no new students, holders keep it. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
