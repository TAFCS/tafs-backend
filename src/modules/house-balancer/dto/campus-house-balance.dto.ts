import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsPositive,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { HouseAssignmentItemDto } from './apply-house-balance.dto';

export class CampusHouseBalancePreviewDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  campus_id!: number;
}

export class CampusHouseBalanceGroupDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  class_id!: number;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  section_id!: number;

  @IsString()
  @MinLength(8)
  roster_fingerprint!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => HouseAssignmentItemDto)
  assignments!: HouseAssignmentItemDto[];
}

export class ApplyCampusHouseBalanceDto extends CampusHouseBalancePreviewDto {
  @IsString()
  @MinLength(8)
  campus_fingerprint!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CampusHouseBalanceGroupDto)
  groups!: CampusHouseBalanceGroupDto[];
}
