import { IsOptional, IsString, IsInt, Min, IsIn, IsArray } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export type FamilyFilterType = 'not_signed_up' | 'signed_up' | 'email_only' | 'no_children';
const VALID_TYPES: FamilyFilterType[] = ['not_signed_up', 'signed_up', 'email_only', 'no_children'];

export class QueryFamiliesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  search?: string;

  /** One or more family types to filter by (OR logic). Sent as repeated query params or comma-joined. */
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]).filter((v: string) => VALID_TYPES.includes(v as FamilyFilterType)))
  @IsArray()
  @IsIn(VALID_TYPES, { each: true })
  types?: FamilyFilterType[];
}
