import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsDateString,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { EXAM_SCHEDULE_STATUSES, ROSTER_STATES } from '../exam-document-rules';
import type { ExamScheduleStatus, RosterState } from '../exam-document-rules';

/** `campus_ids=1,2` or `campus_ids=1&campus_ids=2` both arrive as [1, 2]. */
const toIntArray = ({ value }: { value: unknown }) => {
    if (value == null || value === '') return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
    return parts.map((p) => p.trim()).filter(Boolean).map(Number);
};
export const MISSING_DATA = ['photo', 'father', 'dob'] as const;
export type MissingData = (typeof MISSING_DATA)[number];
export const FEE_DATE_KINDS = ['SCHEDULE', 'OWN'] as const;
export type FeeDateKind = (typeof FEE_DATE_KINDS)[number];

const toStringArray = ({ value }: { value: unknown }) => {
    if (value == null || value === '') return undefined;
    return (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
};

export class ExamScheduleListQueryDto {
    @ApiPropertyOptional({ type: [Number] })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    campus_ids?: number[];

    @ApiPropertyOptional({ example: '2026-2027' })
    @IsOptional()
    @IsString()
    @MaxLength(10)
    academic_year?: string;

    @ApiPropertyOptional({ description: 'Title, segment line or reference number' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    q?: string;
}

export class ExamPaperDto {
    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    class_id!: number;

    @ApiProperty({ example: '2026-12-11' })
    @IsDateString()
    paper_date!: string;

    @ApiProperty({ example: '8:00 – 11:30' })
    @IsString()
    @MinLength(1)
    @MaxLength(60)
    time_text!: string;

    @ApiProperty({ example: 'BIOLOGY / COMPUTER PRACTICAL' })
    @IsString()
    @MinLength(1)
    @MaxLength(255)
    subject!: string;

    @ApiPropertyOptional({ example: '2059 / 01' })
    @IsOptional()
    @IsString()
    @MaxLength(40)
    code?: string;
}

export class ExamScheduleUpsertDto {
    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    campus_id!: number;

    @ApiProperty({ example: '2026-2027' })
    @IsString()
    @MinLength(4)
    @MaxLength(10)
    academic_year!: string;

    @ApiProperty({ example: 'FIRST SEMESTER ASSESSMENTS' })
    @IsString()
    @MinLength(2)
    @MaxLength(150)
    title!: string;

    @ApiPropertyOptional({ example: 'SENIOR CAMBRIDGE' })
    @IsOptional()
    @IsString()
    @MaxLength(150)
    segment_line?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    reference_no?: string;

    @ApiProperty({ description: 'Every fee head dated on or before this must be settled', example: '2026-12-01' })
    @IsDateString()
    fee_date!: string;

    @ApiPropertyOptional({ example: '2026-12-09' })
    @IsOptional()
    @IsDateString()
    issue_from?: string;

    @ApiProperty({ type: [String] })
    @IsArray()
    @ArrayMaxSize(30)
    @IsString({ each: true })
    @MaxLength(600, { each: true })
    notes!: string[];

    @ApiProperty({ type: [Number] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(25)
    @Type(() => Number)
    @IsInt({ each: true })
    class_ids!: number[];

    @ApiProperty({ type: [ExamPaperDto] })
    @IsArray()
    @ArrayMaxSize(400)
    @ValidateNested({ each: true })
    @Type(() => ExamPaperDto)
    papers!: ExamPaperDto[];
}

export class ExamScheduleStatusDto {
    @ApiProperty({ enum: EXAM_SCHEDULE_STATUSES })
    @IsIn(EXAM_SCHEDULE_STATUSES)
    status!: ExamScheduleStatus;
}

export class ExamRosterQueryDto {
    @ApiPropertyOptional({ type: [Number] })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    class_ids?: number[];

    @ApiPropertyOptional({ type: [Number] })
    @IsOptional()
    @Transform(toIntArray)
    @IsInt({ each: true })
    section_ids?: number[];

    @ApiPropertyOptional({ type: [String], enum: ROSTER_STATES })
    @IsOptional()
    @Transform(toStringArray)
    @IsIn(ROSTER_STATES, { each: true })
    states?: RosterState[];

    @ApiPropertyOptional({ description: 'C.C., G.R. or name' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    q?: string;

    @ApiPropertyOptional({ type: [String], description: "Discipline names as the Student Directory sends them; 'none' for no discipline" })
    @IsOptional()
    @Transform(toStringArray)
    @IsString({ each: true })
    @MaxLength(50, { each: true })
    disciplines?: string[];

    @ApiPropertyOptional({ enum: ['true', 'false'] })
    @IsOptional()
    @IsIn(['true', 'false'])
    has_photo?: 'true' | 'false';

    @ApiPropertyOptional({ type: [String], enum: MISSING_DATA, description: 'Students missing any of these' })
    @IsOptional()
    @Transform(toStringArray)
    @IsIn(MISSING_DATA, { each: true })
    missing?: MissingData[];

    @ApiPropertyOptional({ type: [String], enum: FEE_DATE_KINDS, description: "SCHEDULE: checked against the schedule's fee date; OWN: given their own" })
    @IsOptional()
    @Transform(toStringArray)
    @IsIn(FEE_DATE_KINDS, { each: true })
    fee_date_kinds?: FeeDateKind[];
}

export class ExamScheduleFeeDateDto {
    @ApiProperty({ example: '2026-12-01' })
    @IsDateString()
    fee_date!: string;
}

export class ExamStudentFeeDatesDto {
    @ApiProperty({ type: [Number] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(800)
    @Type(() => Number)
    @IsInt({ each: true })
    student_ids!: number[];

    @ApiProperty({ nullable: true, example: '2026-11-01', description: "null puts them back on the schedule's fee date" })
    @IsOptional()
    @IsDateString()
    fee_date!: string | null;

    @ApiPropertyOptional({ description: 'Why these students get a different fee date' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    reason?: string;
}

export class ExamFeeDatePreviewDto {
    @ApiProperty({ type: [Number] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(3000)
    @Type(() => Number)
    @IsInt({ each: true })
    student_ids!: number[];

    @ApiProperty({ example: '2026-11-01' })
    @IsDateString()
    fee_date!: string;
}

export class ExamIssueDto {
    @ApiProperty({ type: [Number], description: 'C.C. numbers. Cleared students get a new document, holders a reprint.' })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(800)
    @Type(() => Number)
    @IsInt({ each: true })
    student_ids!: number[];
}

export class ExamOverrideDto {
    @ApiProperty()
    @Type(() => Number)
    @IsInt()
    student_id!: number;

    @ApiProperty({ description: 'Why the document is issued although dues are outstanding' })
    @IsString()
    @MinLength(5)
    @MaxLength(500)
    reason!: string;
}
