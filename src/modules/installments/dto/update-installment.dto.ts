import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';

export class UpdateInstallmentHeadDto {
  @IsInt()
  student_fee_id: number;

  @IsString()
  @IsOptional()
  fee_date?: string;

  @IsNumber()
  @IsOptional()
  amount?: number;
}

export class UpdateInstallmentDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateInstallmentHeadDto)
  heads: UpdateInstallmentHeadDto[];
}
