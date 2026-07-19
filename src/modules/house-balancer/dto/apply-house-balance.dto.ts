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
import { HouseBalancerScopeDto } from './house-balancer-scope.dto';

export class HouseAssignmentItemDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  student_id!: number;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  house_id!: number;
}

export class ApplyHouseBalanceDto extends HouseBalancerScopeDto {
  @IsString()
  @MinLength(8)
  roster_fingerprint!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => HouseAssignmentItemDto)
  assignments!: HouseAssignmentItemDto[];
}
