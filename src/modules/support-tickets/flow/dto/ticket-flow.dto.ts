import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** A ticket opened by walking the published flow (TAFSD-447). */
export class CreateFlowTicketDto {
  @IsInt()
  @Min(1)
  flowVersion: number;

  /** Step keys from the lane down to the TICKET leaf. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  path: string[];

  @IsOptional()
  @IsInt()
  studentId?: number;

  /** The leaf sets the minimum length; the server checks it. */
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  description: string;

  @IsOptional()
  mediaMetadata?: Record<string, unknown>;
}

export class SaveFlowDraftDto {
  @IsObject()
  tree: Record<string, unknown>;

  @IsInt()
  @Min(0)
  lock_version: number;
}

export class PublishFlowDto {
  @IsInt()
  @Min(0)
  lock_version: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class OpenFlowDraftDto {
  /** Start the draft from this version instead (restore). Replaces any open draft. */
  @IsOptional()
  @IsInt()
  @Min(1)
  from_version?: number;
}

export class FlowRoutePreviewDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  path: string[];

  @IsOptional()
  @IsInt()
  student_cc?: number;

  @IsOptional()
  @IsBoolean()
  draft?: boolean;
}

export class FlowRouteAllDto {
  @IsOptional()
  @IsInt()
  student_cc?: number;

  @IsOptional()
  @IsBoolean()
  draft?: boolean;
}
