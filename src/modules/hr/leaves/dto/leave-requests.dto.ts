import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveRequestStatus } from '@prisma/client';
import { IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { toNumberArray, toStringArray } from '../../../../common/transforms/query-array.transform';

export class CreateLeaveRequestDto {
  @ApiProperty({ description: 'Leave type code: SICK | CASUAL | ANNUAL | UNPAID' })
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  leaveTypeCode: string;

  @ApiProperty({ example: '2026-03-01' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2026-03-03' })
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  attachmentUrl?: string;

  @ApiPropertyOptional({ enum: ['image', 'document'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  attachmentType?: string;
}

export class ListLeaveRequestsQueryDto {
  @ApiPropertyOptional({ type: [Number], description: 'Campus IDs (comma-separated or repeated)' })
  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  campusId?: number[];

  @ApiPropertyOptional({ type: [String], description: 'Leave type codes (comma-separated or repeated)' })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  leaveTypeCode?: string[];

  @ApiPropertyOptional({ enum: LeaveRequestStatus, isArray: true })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsEnum(LeaveRequestStatus, { each: true })
  status?: LeaveRequestStatus[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  toDate?: string;
}

export class ReviewLeaveRequestDto {
  @ApiProperty({ enum: LeaveRequestStatus })
  @IsEnum(LeaveRequestStatus)
  status: LeaveRequestStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewReason?: string;
}

export class RevokeLeaveRequestDto {
  @ApiProperty()
  @IsString()
  @MaxLength(500)
  reviewReason: string;
}
