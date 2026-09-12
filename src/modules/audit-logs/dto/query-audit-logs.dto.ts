import { IsOptional, IsString, IsDateString, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryAuditLogsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  student_id?: number;

  /**
   * Free-text search across the whole row.
   *
   * Whitespace-separated terms are ANDed; each bare term ORs across
   * entity_type, entity_id, action, section, field, old_value, new_value,
   * note and the actor. Terms may be narrowed with a `key:value` prefix —
   * see SEARCH_KEYS in the service.
   */
  @IsOptional()
  @IsString()
  q?: string;

  /** Comma-separated. */
  @IsOptional()
  @IsString()
  entity_type?: string;

  @IsOptional()
  @IsString()
  entity_id?: string;

  /** Comma-separated. */
  @IsOptional()
  @IsString()
  section?: string;

  /** Comma-separated. */
  @IsOptional()
  @IsString()
  action?: string;

  /** Comma-separated. */
  @IsOptional()
  @IsString()
  field?: string;

  @IsOptional()
  @IsString()
  changed_by?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  offset?: number;
}
