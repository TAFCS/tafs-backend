import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * TAFSD-448: send a ticket somewhere else. Give either a flow topic (`leafKey`,
 * routed as if the parent had picked it) or a desk (`queueId`, optionally with
 * one of its members in `targetUserId`).
 */
export class MoveTicketDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z0-9][a-z0-9_-]*$/)
  leafKey?: string;

  @IsOptional()
  @IsInt()
  queueId?: number;

  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(3, 500)
  reason: string;

  /** Super admins only: move to a destination whose scope does not cover the student. */
  @IsOptional()
  @IsBoolean()
  overrideScope?: boolean;
}
