import { IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAccessPackDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tileIds?: string[];
}

export class UpdateAccessPackDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tileIds?: string[];
}

export class TileGrantDto {
  @IsString()
  tileId: string;

  @IsBoolean()
  allow: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

export class SetUserAccessDto {
  @IsArray()
  @IsString({ each: true })
  packIds: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TileGrantDto)
  tileGrants: TileGrantDto[];
}
