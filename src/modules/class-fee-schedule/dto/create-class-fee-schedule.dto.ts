import { IsNumber, IsPositive } from 'class-validator';

export class CreateClassFeeScheduleDto {
  @IsNumber()
  @IsPositive()
  class_id: number;

  @IsNumber()
  @IsPositive()
  fee_id: number;

  @IsNumber()
  @IsPositive()
  amount: number;
}
