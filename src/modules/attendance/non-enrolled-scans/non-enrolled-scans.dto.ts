import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** `campus_ids=1,2` or `campus_ids=1&campus_ids=2` both arrive as [1, 2]. */
const toIntArray = ({ value }: { value: unknown }) => {
  if (value == null || value === '') return undefined;
  const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
  return parts.map((p) => p.trim()).filter(Boolean).map(Number);
};

export class NonEnrolledReportQueryDto {
  @ApiPropertyOptional({ description: 'First day, YYYY-MM-DD. Defaults to today (Pakistan).' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'Last day, YYYY-MM-DD. Defaults to `from`.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({ type: [Number], description: 'Campus ids; omitted means every campus you can see.' })
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  campus_ids?: number[];

  @ApiPropertyOptional({ type: [Number], description: "Segment ids (through the student's class); omitted means every segment you can see." })
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  segment_ids?: number[];

  @ApiPropertyOptional({ description: 'Student name, C.C. or G.R.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
