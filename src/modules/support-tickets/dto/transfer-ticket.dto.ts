import { IsString, IsUUID } from 'class-validator';

export class TransferTicketDto {
  @IsUUID()
  targetUserId: string;
}
