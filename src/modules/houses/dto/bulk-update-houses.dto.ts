import { IsArray, IsBoolean, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class HouseUpdateItemDto {
  @IsInt()
  id: number;

  @IsOptional()
  @IsString()
  house_name?: string;

  @IsOptional()
  @IsString()
  house_color?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class BulkUpdateHousesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HouseUpdateItemDto)
  items: HouseUpdateItemDto[];
}
