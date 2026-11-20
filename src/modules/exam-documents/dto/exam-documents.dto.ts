import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsDateString,
    IsIn,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { EXAM_SCHEDULE_STATUSES, ROSTER_STATES } from '../exam-document-rules';
import type { ExamScheduleStatus, RosterState } from '../exam-document-rules';
import { SCHEDULE_LAYOUTS } from '../exam-schedule-layouts';
import type { ScheduleLayout } from '../exam-schedule-layouts';

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

    /** TAFSD-522: a session, "YYYY-YYYY" with consecutive years (checked in the service). */
    @ApiProperty({ example: '2026-2027' })
    @IsString()
    @Matches(/^\d{4}-\d{4}$/, { message: 'academic_year must be a session like 2026-2027' })
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

    /** TAFSD-525: which of the school's sheets the Excel export copies. Left out: taken from the classes. */
    @ApiPropertyOptional({ enum: SCHEDULE_LAYOUTS })
    @IsOptional()
    @IsIn(SCHEDULE_LAYOUTS)
    layout?: ScheduleLayout;

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

/** TAFSD-525: one paper row of a preset, without a date. */
export class ExamPresetRowDto {
    @ApiProperty({ example: '8:00 – 11:30' })
    @IsString()
    @MaxLength(60)
    time!: string;

    @ApiProperty({ description: 'class id → subject', example: { '18': 'PHYSICS PRACTICAL' } })
    @IsObject()
    cells!: Record<string, string>;

    @ApiPropertyOptional({ description: "class id → that class's own time (O Levels)" })
    @IsOptional()
    @IsObject()
    times?: Record<string, string>;
}

/** TAFSD-525: save a schedule's layout, classes, subjects and notes as a preset. */
export class ExamPresetCreateDto {
    @ApiProperty({ example: 'First Semester — Senior Cambridge' })
    @IsString()
    @MinLength(2)
    @MaxLength(150)
    name!: string;

    @ApiProperty({ enum: SCHEDULE_LAYOUTS })
    @IsIn(SCHEDULE_LAYOUTS)
    layout!: ScheduleLayout;

    @ApiProperty()
    @IsString()
    @MinLength(2)
    @MaxLength(150)
    title!: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(150)
    segment_line?: string;

    @ApiProperty({ type: [Number] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(25)
    @Type(() => Number)
    @IsInt({ each: true })
    class_ids!: number[];

    @ApiProperty({ type: [ExamPresetRowDto] })
    @IsArray()
    @ArrayMaxSize(60)
    @ValidateNested({ each: true })
    @Type(() => ExamPresetRowDto)
    rows!: ExamPresetRowDto[];

    @ApiProperty({ type: [String] })
    @IsArray()
    @ArrayMaxSize(30)
    @IsString({ each: true })
    @MaxLength(600, { each: true })
    notes!: string[];
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

    @ApiPropertyOptional({
        description:
            'TAFSD-543: leave students who already hold a document alone (they show in the report as already issued) instead of reprinting them. For "issue to the whole class" runs.',
    })
    @IsOptional()
    @IsBoolean()
    skip_holders?: boolean;
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
