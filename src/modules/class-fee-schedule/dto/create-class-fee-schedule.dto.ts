import { IsNumber, IsPositive, IsOptional, Min } from 'class-validator';

export class CreateClassFeeScheduleDto {
  @IsNumber()
  @IsPositive()
  class_id: number;

  @IsNumber()
  @IsPositive()
  fee_id: number;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsNumber()
  @IsPositive()
  @IsOptional()
  campus_id?: number;
}
