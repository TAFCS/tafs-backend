import { IsOptional, IsString, IsUUID } from 'class-validator';

export class MarkTicketReadDto {
  @IsUUID()
  ticketId: string;

  @IsOptional()
  @IsString()
  role?: 'parent' | 'staff';
}
