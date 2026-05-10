import { IsNumber, IsNotEmpty } from 'class-validator';

export class ClearDepositDto {
  @IsNumber()
  @IsNotEmpty()
  depositId: number;
}
