import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';

export class ZkPushDto {
  @IsString()
  sn: string;

  @IsOptional()
  @IsString()
  table?: string;

  @IsOptional()
  @IsString()
  Stamp?: string;

  @IsOptional()
  @IsString()
  UserID?: string;

  @IsOptional()
  @IsString()
  Verify?: string;

  @IsOptional()
  @IsString()
  InOutStatus?: string;

  @IsOptional()
  @IsString()
  WorkCode?: string;

  @IsOptional()
  @IsString()
  AttendancePhoto?: string;

  @IsOptional()
  @IsString()
  Reserved?: string;
}

export class GetZkLogsQueryDto {
  @IsOptional()
  @IsString()
  sn?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cursor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}
