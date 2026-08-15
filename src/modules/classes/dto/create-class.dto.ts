import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

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

  /**
   * Calendar month the class's academic year starts in — 8 for the standard
   * Aug-Jul term, 4 for the Apr-Mar term the Secondary classes run on.
   * Defaults to 8 in the DB. Every month label and chronological sort for this
   * class's fee heads depends on it, so an Apr-Mar class created without it
   * will render its Apr-Jul months a year out.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  term_start_month?: number;
}

