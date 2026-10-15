import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class SetManagersDto {
  @ApiProperty({
    type: [Number],
    description:
      'Employee profile ids this person reports to, in order. Replaces the current set; [] removes every line. ' +
      'The first is shown as the reporting manager on the employee record.',
  })
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  manager_ids: number[];
}
