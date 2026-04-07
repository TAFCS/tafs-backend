import { IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class EnrollStudentDto {
  @ApiProperty({ example: '3208', description: 'Assigned GR number' })
  @IsString()
  gr_number: string;

  @ApiProperty({ example: 1, description: 'Assigned house ID' })
  @IsNumber()
  house_id: number;

  @ApiProperty({ example: 1, description: 'Assigned section ID', required: false })
  @IsOptional()
  @IsNumber()
  section_id?: number;
}
