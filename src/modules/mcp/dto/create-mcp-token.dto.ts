import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MCP_TOKEN_MAX_DAYS } from '../mcp-token.util';

export class CreateMcpTokenDto {
  /** What the token is for, e.g. "Claude Code on my laptop". */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MCP_TOKEN_MAX_DAYS)
  expires_in_days?: number;
}
