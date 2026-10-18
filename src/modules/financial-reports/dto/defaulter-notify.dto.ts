import { IsDateString, IsOptional, Matches } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** TAFSD-384: the report's as-of date, so the notice quotes the figures on screen. Defaults to today. */
export class DefaulterNotifyPreviewQueryDto {
  @IsOptional()
  @IsDateString()
  @Matches(DATE_ONLY, { message: 'as_of_date must be YYYY-MM-DD' })
  as_of_date?: string;
}

export class DefaulterNotifyBodyDto extends DefaulterNotifyPreviewQueryDto {}
