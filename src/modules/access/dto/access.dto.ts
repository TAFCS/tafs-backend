import { IsArray, IsBoolean, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
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

/**
 * A user's universal data scope. An OMITTED or EMPTY array means UNRESTRICTED
 * on that dimension, not "nothing" -- see common/scope/scope.types.ts.
 */
export class UserScopeDto {
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  campuses?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  segments?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  classes?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  sections?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  departments?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  staffCategories?: number[];
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

  /** Omit to leave the user's scope untouched. */
  @IsOptional()
  @ValidateNested()
  @Type(() => UserScopeDto)
  scope?: UserScopeDto;
}
