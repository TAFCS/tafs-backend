import { IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class TileActionRefDto {
  @IsString()
  tileId: string;

  @IsString()
  actionId: string;
}

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

  /** Sub-permissions this pack carries, as {tileId, actionId} pairs. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TileActionRefDto)
  tileActions?: TileActionRefDto[];
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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TileActionRefDto)
  tileActions?: TileActionRefDto[];
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

export class TileActionGrantDto extends TileActionRefDto {
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

  /** Per-user sub-permission overrides. allow=false beats every grant. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TileActionGrantDto)
  tileActionGrants?: TileActionGrantDto[];
}
