import { ArrayNotEmpty, IsArray, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class WaiveHeadsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  student_fee_ids: number[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UnwaiveHeadsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  student_fee_ids: number[];
}
