import { IsOptional, IsString } from 'class-validator';

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
}
