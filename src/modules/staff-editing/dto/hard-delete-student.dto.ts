import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class HardDeleteStudentDto {
  @ApiProperty({ description: 'Why this student is being permanently deleted. Recorded in the audit log.' })
  @IsString()
  @MinLength(3, { message: 'A reason is required to permanently delete a student' })
  reason!: string;
}
