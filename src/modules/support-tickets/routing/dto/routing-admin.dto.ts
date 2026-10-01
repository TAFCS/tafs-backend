import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { TicketCategory, TicketChildMatch, TicketQueueAssignment } from '@prisma/client';

export class CreateRoutingRuleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsEnum(TicketCategory)
  category: TicketCategory;

  @IsOptional()
  @IsEnum(TicketChildMatch)
  child_match?: TicketChildMatch;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  campus_id?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  segment_id?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  class_ids?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  subtopic?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  target_user_id?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  target_queue_id?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdateRoutingRuleDto extends PartialType(CreateRoutingRuleDto) {}

export class CreateTicketQueueDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsEnum(TicketCategory)
  category: TicketCategory;

  @IsOptional()
  @IsEnum(TicketQueueAssignment)
  assignment?: TicketQueueAssignment;

  @IsOptional()
  @IsBoolean()
  allow_forward?: boolean;

  @IsOptional()
  @IsBoolean()
  is_fallback?: boolean;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  /** Ordered: AUTO queues try members in this order. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  member_ids?: string[];
}

export class UpdateTicketQueueDto extends PartialType(CreateTicketQueueDto) {}

export class RoutingPreviewDto {
  @IsEnum(TicketCategory)
  category: TicketCategory;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  subtopic?: string;

  /** Student CC; omit for a family-level ticket. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  student_cc?: number;
}
