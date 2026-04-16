import { IsInt, IsPositive } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class AssignStudentDto {
  @Type(() => Number)
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @IsPositive()
  student_id: number;
}
