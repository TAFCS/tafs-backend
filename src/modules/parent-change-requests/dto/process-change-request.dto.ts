import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum ChangeRequestStatus {
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export class ProcessChangeRequestDto {
  @IsEnum(ChangeRequestStatus)
  status: ChangeRequestStatus;

  @IsOptional()
  @IsString()
  comment?: string;
}
