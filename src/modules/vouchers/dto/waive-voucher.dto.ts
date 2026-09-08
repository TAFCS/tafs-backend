import { IsOptional, IsString, MaxLength } from 'class-validator';

export class WaiveVoucherDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
