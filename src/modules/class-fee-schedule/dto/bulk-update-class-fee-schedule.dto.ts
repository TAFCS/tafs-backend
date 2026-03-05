import { IsArray, ValidateNested, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

class UpdateClassFeeScheduleItemDto {
  @IsNumber()
  id: number;

  @IsNumber()
  @IsOptional()
  class_id?: number;

  @IsNumber()
  @IsOptional()
  fee_id?: number;

  @IsNumber()
  @IsOptional()
  amount?: number;
}

export class BulkUpdateClassFeeScheduleDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateClassFeeScheduleItemDto)
  items: UpdateClassFeeScheduleItemDto[];
}
