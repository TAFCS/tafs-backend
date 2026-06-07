import { IsString, IsUUID } from 'class-validator';

export class ForwardTicketDto {
  @IsUUID()
  targetUserId: string;
}
