import { IsOptional, IsString } from 'class-validator';

export class DisbursePayrollLineDto {
  @IsOptional()
  @IsString()
  disbursed_at?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
