import { IsEnum, IsNotEmpty, IsString, ValidateIf } from 'class-validator';
import { MessageStatus } from '@prisma/client';

export class ReviewTicketMessageDto {
  @IsEnum(MessageStatus)
  status: Extract<MessageStatus, 'APPROVED' | 'REJECTED'>;

  @ValidateIf((dto: ReviewTicketMessageDto) => dto.status === MessageStatus.REJECTED)
  @IsNotEmpty({ message: 'Rejection reason is required' })
  @IsString()
  comment?: string;
}
