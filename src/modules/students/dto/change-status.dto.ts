import { IsEnum, IsOptional, IsString } from 'class-validator';
import { StudentStatus } from '../../../constants/student-status.constant';

export class ChangeStatusDto {
  @IsEnum(StudentStatus, {
    message: `status must be one of: ${Object.values(StudentStatus).join(', ')}`,
  })
  status!: StudentStatus;

  @IsOptional()
  @IsString()
  reason?: string;
}
