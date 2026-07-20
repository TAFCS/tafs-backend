import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';

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

  /**
   * When approving guardian/student field updates, optionally limit which fields
   * are applied. Unselected fields stay on the original pending request.
   * Field names match keys in `requested_data` (or `requested_data.changes` for
   * STUDENT_UPDATE). Ignored for ACCOUNT_DELETION and REJECTED.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  approved_fields?: string[];
}
