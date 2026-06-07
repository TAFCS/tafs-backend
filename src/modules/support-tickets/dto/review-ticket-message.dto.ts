import { IsEnum, IsOptional, IsString } from 'class-validator';
import { MessageStatus } from '@prisma/client';

export class ReviewTicketMessageDto {
  @IsEnum(MessageStatus)
  status: Extract<MessageStatus, 'APPROVED' | 'REJECTED'>;

  @IsOptional()
  @IsString()
  comment?: string;
}
