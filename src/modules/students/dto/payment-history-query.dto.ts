import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class PaymentHistoryQueryDto {
  @ApiProperty({
    description: 'Academic year to filter data',
    example: '2025-2026',
  })
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, {
    message: 'Academic year must be in format YYYY-YYYY',
  })
  academic_year: string;
}
