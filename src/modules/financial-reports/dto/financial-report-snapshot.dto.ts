import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FinancialReportSnapshotStatus } from '@prisma/client';
import { ListFeeHeadsQueryDto } from './financial-report-query.dto';

export class CreateFeeHeadsSnapshotDto extends ListFeeHeadsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ListFeeHeadsSnapshotsQueryDto {
  @IsOptional()
  @IsIn(['DRAFT', 'FINALIZED'])
  status?: FinancialReportSnapshotStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
