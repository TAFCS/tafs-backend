import { IsEnum, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { TicketCategory } from '@prisma/client';

export class CreateTicketDto {
  @IsEnum(TicketCategory)
  category: TicketCategory;

  @IsOptional()
  @IsInt()
  studentId?: number;

  @IsString()
  @MinLength(1)
  subtopic: string;

  @IsString()
  @MinLength(20)
  @MaxLength(150)
  description: string;

  @IsOptional()
  mediaMetadata?: Record<string, unknown>;
}
