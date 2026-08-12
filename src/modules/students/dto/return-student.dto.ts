import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StudentReturnMode } from '../../../constants/student-return-mode.constant';

export class ReturnStudentDto {
  @ApiProperty({
    enum: StudentReturnMode,
    description:
      'REINSTATED restores the exact prior placement; READMITTED re-assigns placement and writes a new admission record.',
  })
  @IsEnum(StudentReturnMode, {
    message: `mode must be one of: ${Object.values(StudentReturnMode).join(', ')}`,
  })
  mode!: StudentReturnMode;

  @ApiPropertyOptional({ description: 'Why the student is returning. Shown in the progression gap row.' })
  @IsOptional()
  @IsString()
  reason?: string;

  // ---- READMITTED only ----

  @ApiPropertyOptional({ example: '3208' })
  @IsOptional()
  @IsString()
  gr_number?: string;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @IsInt()
  class_id?: number;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsInt()
  section_id?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  house_id?: number;

  @ApiPropertyOptional({ example: '2026-2027' })
  @IsOptional()
  @IsString()
  academic_year?: string;
}
