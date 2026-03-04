import { IsInt, IsPositive } from 'class-validator';
import { Type } from 'class-transformer';

export class AssignStudentDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  student_id: number;
}
