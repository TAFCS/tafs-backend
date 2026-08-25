import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { StudentStatus } from '../../../constants/student-status.constant';

export class ChangeStatusDto {
  @IsEnum(StudentStatus, {
    message: `status must be one of: ${Object.values(StudentStatus).join(', ')}`,
  })
  status!: StudentStatus;

  @IsOptional()
  @IsString()
  reason?: string;

  /** Only used when status is GRADUATED. Defaults to the student's current academic_year if omitted. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, { message: 'graduated_academic_year must be in YYYY-YYYY format' })
  graduated_academic_year?: string;
}
