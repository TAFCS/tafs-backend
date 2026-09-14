import { IsString, MinLength } from 'class-validator';

export class EditTicketMessageDto {
  @IsString()
  @MinLength(1)
  content: string;
}
