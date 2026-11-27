import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { EcBulkTargetDto } from '../../charges/dto/ec-charges.dto';
import { toIntArray } from '../../ec-common.util';

/** Students per bulk-issue call; the client sends chunks one after another. */
export const EC_BULK_ISSUE_MAX_STUDENTS = 100;

const toStringArray = ({ value }: { value: unknown }) => {
    if (value == null || value === '') return undefined;
    return (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
};

/** Which unissued charges go on bulk vouchers. Every array is multi-select; empty means all. */
export class EcBulkIssueFilterDto extends EcBulkTargetDto {
    @ApiPropertyOptional({ type: [Number] })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    fee_head_ids?: number[];

    @ApiPropertyOptional({ type: [Number], description: 'Calendar months 1-12' })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(12)
    @Type(() => Number)
    @IsInt({ each: true })
    @Min(1, { each: true })
    @Max(12, { each: true })
    months?: number[];

    @ApiPropertyOptional({ type: [String] })
    @IsOptional()
    @Transform(toStringArray)
    @IsString({ each: true })
    @MaxLength(10, { each: true })
    academic_years?: string[];
}

/**
 * One call of a bulk run: the run's filters (the same as its preview) plus the
 * chunk of students to issue for now. A C.C. in the chunk that the filters
 * don't select is reported, never issued.
 */
export class EcBulkIssueDto extends EcBulkIssueFilterDto {
    @ApiProperty({ type: [Number], description: `This chunk of students, at most ${EC_BULK_ISSUE_MAX_STUDENTS}` })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(EC_BULK_ISSUE_MAX_STUDENTS)
    @Type(() => Number)
    @IsInt({ each: true })
    chunk_student_ids: number[];

    @ApiProperty({ example: '2026-11-27' })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'issue_date must be YYYY-MM-DD' })
    issue_date: string;

    @ApiPropertyOptional({ description: 'Default: 15 days after the issue date' })
    @IsOptional()
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expiry_date must be YYYY-MM-DD' })
    expiry_date?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    bank_account_id?: number;

    @ApiProperty({ description: 'One id for the whole run (all its chunks), stored on every voucher it issues' })
    @IsString()
    @Matches(/^[A-Za-z0-9-]{8,36}$/, { message: 'run_id must be 8-36 letters, digits or dashes' })
    run_id: string;
}
