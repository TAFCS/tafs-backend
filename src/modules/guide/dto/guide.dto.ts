import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Matches } from 'class-validator';

export class GuideCombineDto {
  @ApiProperty({ type: [String], example: ['finance/defaulters-report', 'students/quick-registration'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Matches(/^[a-z0-9-]+\/[a-z0-9-]+$/, { each: true })
  modules!: string[];
}
