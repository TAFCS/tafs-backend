import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class GetByCcParamsDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^CC-\d{4}-\d{5}$/, {
    message: 'cc must be in format CC-YYYY-NNNNN',
  })
  cc: string;
}

