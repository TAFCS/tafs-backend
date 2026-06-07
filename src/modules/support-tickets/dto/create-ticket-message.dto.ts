import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { ChatMessageType } from '@prisma/client';

export class CreateTicketMessageDto {
  @IsEnum(ChatMessageType)
  messageType: ChatMessageType;

  @IsString()
  @MinLength(1)
  content: string;

  @IsOptional()
  mediaMetadata?: Record<string, unknown>;
}
