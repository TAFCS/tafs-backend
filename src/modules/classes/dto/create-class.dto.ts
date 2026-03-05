import { IsString, Length } from 'class-validator';

export class CreateClassDto {
  @IsString()
  @Length(1, 255)
  description: string;

  @IsString()
  @Length(1, 10)
  class_code: string;

  @IsString()
  @Length(1, 20)
  academic_system: string;
}

