import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { renderToBuffer } from '@react-pdf/renderer';
import React from 'react';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScopeService } from '../../common/scope/scope.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { StorageService } from '../../common/storage/storage.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { findStudentSearchHits } from '../students/student-search-match';
import {
    ExamFeeDatePreviewDto,
    ExamIssueDto,
    ExamOverrideDto,
    ExamPresetCreateDto,
    ExamReleaseDto,
    ExamRosterQueryDto,
    ExamUnreleaseDto,
    ExamScheduleListQueryDto,
    ExamScheduleUpsertDto,
    ExamStudentFeeDatesDto,
} from './dto/exam-documents.dto';
import {
    DOC_TYPE_LABEL,
    DuesThrough,
    MonthOwed,
    NO_DUES,
    ROSTER_STATES,
    RosterState,
    billedOwed,
    docTypeForClass,
    effectiveFeeDate,
    feeDateLabel,
    formatSerial,
    isSessionLabel,
    issueWindowOpen,
    notOfferedClasses,
    rosterState,
    totalOwed,
} from './exam-document-rules';
import type { ExamDocType, ExamScheduleStatus } from './exam-document-rules';
import {
    RELEASE_OUTCOME_LABEL,
    ReleaseOutcome,
    cleanReleaseMessage,
    releaseBody,
    releaseOutcome,
    releaseTitle,
} from './exam-document-release';
import { ExamDocPage, ExamDocumentsPDF } from './ExamDocumentPDF';
import { CAMBRIDGE_CENTRE, buildExamDocPage, dmy } from './exam-document-page';
import { buildScheduleWorkbook } from './exam-schedule-export';
import {
    RunStudent,
    SKIP_REASONS,
    SkipCode,
    buildRunWorkbook,
    duesSkip,
    eligibilitySkip,
    gapsOf,
    runCounts,
    runLabel,
    sortRunStudents,
} from './exam-document-runs';
import { campusOnSheet, inferScheduleLayout, isScheduleLayout, presetRows } from './exam-schedule-layouts';

type Staff = IJwtStaffPayload;

/** Advisory-lock namespace for serial allocation (the ticket number). */
const SERIAL_LOCK_NS = 510;
const ROSTER_CAP = 3000;
const PHOTO_CONCURRENCY = 8;


const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

function karachiToday(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
}


const SCHEDULE_INCLUDE = {
    campuses: { select: { id: true, campus_name: true, campus_code: true, address: true } },
    exam_schedule_classes: { include: { classes: { select: { id: true, description: true } } } },
    exam_schedule_papers: { orderBy: [{ paper_date: 'asc' }, { sort_order: 'asc' }, { id: 'asc' }] },
    _count: { select: { exam_documents: true, exam_schedule_fee_dates: true } },
} satisfies Prisma.exam_schedulesInclude;

type ScheduleRow = Prisma.exam_schedulesGetPayload<{ include: typeof SCHEDULE_INCLUDE }>;

const STUDENT_SELECT = {
    cc: true,
    full_name: true,
    gr_number: true,
    dob: true,
    gender: true,
    status: true,
    campus_id: true,
    class_id: true,
    section_id: true,
    photo_blue_bg_url: true,
    photograph_url: true,
    classes: { select: { id: true, description: true, segment_id: true } },
    sections: { select: { id: true, description: true } },
    student_guardians: { select: { relationship: true, guardians: { select: { full_name: true } } } },
    student_admissions: { select: { discipline: true }, orderBy: { application_date: 'desc' }, take: 1 },
} satisfies Prisma.studentsSelect;

type StudentRow = Prisma.studentsGetPayload<{ select: typeof STUDENT_SELECT }>;

const fatherOf = (s: StudentRow) =>
    s.student_guardians.find((g) => g.relationship?.toLowerCase() === 'father')?.guardians?.full_name ?? '';

/** TAFSD-543: what one Issue run hands back. No buffer when nothing could be printed. */
export interface IssueOutcome {
    buffer: Buffer | null;
    filename: string;
    issued: number;
    reprinted: number;
    skipped: number;
    /** The saved report, or null if it could not be saved. */
    run_id: number | null;
    /** Documents issued but the PDF failed. */
    error: string | null;
}

/**
 * TAFSD-510: exam schedules, and the admit cards (VI–X) / statements of entry
 * (every other class) issued from them to students whose dues are cleared
 * through the schedule's fee month. Reads money, never writes it.
 */
@Injectable()
export class ExamDocumentsService {
    private readonly logger = new Logger(ExamDocumentsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly scope: ScopeService,
        private readonly auditLogs: AuditLogsService,
        private readonly storage: StorageService,
        private readonly fcm: FcmService,
    ) {}

    private by(user: Staff) {
        return String(user?.username || user?.sub || 'system').slice(0, 100);
    }

    // ─── Schedules ─────────────────────────────────────────────────────────

    private serializeSchedule(row: ScheduleRow) {
        const classes = row.exam_schedule_classes
            .map((c) => ({ id: c.class_id, description: c.classes.description, doc_type: docTypeForClass(c.class_id) }))
            .sort((a, b) => a.id - b.id);
        return {
            id: row.id,
            campus_id: row.campus_id,
            campus_name: row.campuses.campus_name,
            academic_year: row.academic_year,
            title: row.title,
            segment_line: row.segment_line,
            reference_no: row.reference_no,
            fee_date: iso(row.fee_date)!,
            fee_date_label: feeDateLabel(iso(row.fee_date)!),
            students_with_own_fee_date: row._count.exam_schedule_fee_dates,
            issue_from: iso(row.issue_from),
            notes: row.notes,
            /** TAFSD-525: the sheet the export copies; `layout_chosen` false when it was taken from the classes. */
            layout: isScheduleLayout(row.layout) ? row.layout : inferScheduleLayout(classes.map((c) => c.id)),
            layout_chosen: isScheduleLayout(row.layout),
            status: row.status as ExamScheduleStatus,
            classes,
            papers: row.exam_schedule_papers.map((p) => ({
                id: p.id,
                class_id: p.class_id,
                paper_date: iso(p.paper_date),
                time_text: p.time_text,
                subject: p.subject,
                code: p.code,
                sort_order: p.sort_order,
            })),
            documents_issued: row._count.exam_documents,
            created_by: row.created_by,
            updated_by: row.updated_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }

    private async loadSchedule(id: number, user: Staff): Promise<ScheduleRow> {
        const row = await this.prisma.exam_schedules.findUnique({ where: { id }, include: SCHEDULE_INCLUDE });
        if (!row) throw new NotFoundException('Exam schedule not found');
        this.scope.assertCampus(user, row.campus_id);
        return row;
    }

    async listSchedules(query: ExamScheduleListQueryDto, user: Staff) {
        const q = query.q?.trim();
        const rows = await this.prisma.exam_schedules.findMany({
            where: {
                ...(query.campus_ids?.length && { campus_id: { in: query.campus_ids } }),
                ...(query.academic_year && { academic_year: query.academic_year }),
                ...(q && {
                    OR: [
                        { title: { contains: q, mode: 'insensitive' } },
                        { segment_line: { contains: q, mode: 'insensitive' } },
                        { reference_no: { contains: q, mode: 'insensitive' } },
                    ],
                }),
            },
            include: SCHEDULE_INCLUDE,
            orderBy: [{ academic_year: 'desc' }, { created_at: 'desc' }],
            take: 500,
        });
        return rows
            .filter((r) => {
                try {
                    this.scope.assertCampus(user, r.campus_id);
                    return true;
                } catch {
                    return false;
                }
            })
            .map((r) => {
                const s = this.serializeSchedule(r);
                return { ...s, papers: undefined, paper_count: s.papers.length };
            });
    }

    async getSchedule(id: number, user: Staff) {
        return this.serializeSchedule(await this.loadSchedule(id, user));
    }

    /** TAFSD-524: the schedule as an Excel sheet copying the school's own (layout per TAFSD-525). */
    async exportSchedule(id: number, user: Staff): Promise<{ buffer: Buffer; filename: string }> {
        const schedule = await this.loadSchedule(id, user);
        const classes = schedule.exam_schedule_classes.map((c) => ({ id: c.class_id, description: c.classes.description }));
        const layout = isScheduleLayout(schedule.layout) ? schedule.layout : inferScheduleLayout(classes.map((c) => c.id));
        const campus = campusOnSheet(schedule.campuses);
        const buffer = await buildScheduleWorkbook({
            layout,
            title: schedule.title,
            segmentLine: schedule.segment_line,
            academicYear: schedule.academic_year,
            campusLabel: campus.label,
            campusAddress: campus.address,
            referenceNo: schedule.reference_no,
            letterDate: karachiToday(),
            classes,
            papers: schedule.exam_schedule_papers.map((p) => ({
                class_id: p.class_id,
                date: iso(p.paper_date)!,
                time: p.time_text,
                subject: p.subject,
            })),
            notes: schedule.notes,
        });
        const safe = (s: string) => s.replace(/[^A-Za-z0-9 &()-]+/g, ' ').replace(/\s+/g, ' ').trim();
        return {
            buffer,
            filename: `Exam schedule - ${safe(schedule.title)} - ${safe(schedule.campuses.campus_name)} ${schedule.academic_year}.xlsx`,
        };
    }

    // ─── Presets (TAFSD-525) ───────────────────────────────────────────────

    /** Every preset, in the order the school uses them. */
    async listPresets() {
        const rows = await this.prisma.exam_schedule_presets.findMany({ orderBy: [{ sort_order: 'asc' }, { name: 'asc' }] });
        const classIds = [...new Set(rows.flatMap((r) => r.class_ids))];
        const names = new Map(
            (await this.prisma.classes.findMany({ where: { id: { in: classIds } }, select: { id: true, description: true } })).map((c) => [
                c.id,
                c.description,
            ]),
        );
        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            layout: isScheduleLayout(r.layout) ? r.layout : inferScheduleLayout(r.class_ids),
            title: r.title,
            segment_line: r.segment_line,
            classes: r.class_ids.map((id) => ({ id, description: names.get(id) ?? `Class ${id}` })),
            rows: presetRows(r.rows),
            notes: r.notes,
            created_by: r.created_by,
            updated_at: r.updated_at,
        }));
    }

    async createPreset(dto: ExamPresetCreateDto, user: Staff) {
        const classIds = [...new Set(dto.class_ids)];
        const known = await this.prisma.classes.count({ where: { id: { in: classIds } } });
        if (known !== classIds.length) throw new BadRequestException('Unknown class in the preset');
        const rows = presetRows(dto.rows).map((r) => ({
            ...r,
            cells: Object.fromEntries(Object.entries(r.cells).filter(([id]) => classIds.includes(Number(id)))),
        }));
        const last = await this.prisma.exam_schedule_presets.aggregate({ _max: { sort_order: true } });
        const created = await this.prisma.exam_schedule_presets.create({
            data: {
                name: dto.name.trim(),
                layout: dto.layout,
                title: dto.title.trim(),
                segment_line: dto.segment_line?.trim() || null,
                class_ids: classIds.sort((a, b) => a - b),
                rows: rows as unknown as Prisma.InputJsonValue,
                notes: dto.notes.map((n) => n.trim()).filter(Boolean),
                sort_order: (last._max.sort_order ?? 0) + 10,
                created_by: this.by(user),
            },
            select: { id: true },
        });
        await this.auditLogs.log({
            entity_type: 'EXAM_SCHEDULE_PRESET',
            entity_id: String(created.id),
            action: 'CREATED',
            new_value: dto.name.trim(),
            changed_by: this.by(user),
        });
        return (await this.listPresets()).find((p) => p.id === created.id);
    }

    async deletePreset(id: number, user: Staff) {
        const preset = await this.prisma.exam_schedule_presets.findUnique({ where: { id }, select: { id: true, name: true } });
        if (!preset) throw new NotFoundException('Preset not found');
        await this.prisma.exam_schedule_presets.delete({ where: { id } });
        await this.auditLogs.log({
            entity_type: 'EXAM_SCHEDULE_PRESET',
            entity_id: String(id),
            action: 'DELETED',
            old_value: preset.name,
            changed_by: this.by(user),
        });
        return { id };
    }

    private async validateUpsert(dto: ExamScheduleUpsertDto, user: Staff) {
        this.scope.assertCampus(user, dto.campus_id);
        const campus = await this.prisma.campuses.findUnique({ where: { id: dto.campus_id }, select: { id: true } });
        if (!campus) throw new BadRequestException('Unknown campus');

        // TAFSD-522: a real session, consecutive years.
        if (!isSessionLabel(dto.academic_year)) {
            throw new BadRequestException('Choose the academic session, like 2026-2027');
        }

        const classIds = [...new Set(dto.class_ids)];
        const classes = await this.prisma.classes.findMany({
            where: { id: { in: classIds } },
            select: { id: true, description: true },
        });
        if (classes.length !== classIds.length) throw new BadRequestException('Unknown class in the schedule');

        // TAFSD-523: only classes the campus offers.
        const offered = await this.prisma.campus_classes.findMany({
            where: { campus_id: dto.campus_id, class_id: { in: classIds }, NOT: { is_active: false } },
            select: { class_id: true },
        });
        const notOffered = notOfferedClasses(classIds, offered.map((o) => o.class_id));
        if (notOffered.length) {
            const names = classes.filter((c) => notOffered.includes(c.id)).map((c) => c.description);
            throw new BadRequestException(`This campus does not offer ${names.join(', ')}`);
        }

        const stray = dto.papers.find((p) => !classIds.includes(p.class_id));
        if (stray) throw new BadRequestException(`A paper is set for class ${stray.class_id}, which the schedule does not cover`);

        const feeDate = dto.fee_date.slice(0, 10);
        const notes = dto.notes.map((n) => n.trim()).filter(Boolean);
        return { classIds, feeDate, notes };
    }

    private paperRows(dto: ExamScheduleUpsertDto) {
        // Keep the order the editor sent within each date, so "P1 / P2" rows stay put.
        return dto.papers.map((p, i) => ({
            class_id: p.class_id,
            paper_date: new Date(`${p.paper_date.slice(0, 10)}T00:00:00Z`),
            time_text: p.time_text.trim(),
            subject: p.subject.trim(),
            code: p.code?.trim() || null,
            sort_order: i,
        }));
    }

    async createSchedule(dto: ExamScheduleUpsertDto, user: Staff) {
        const { classIds, feeDate, notes } = await this.validateUpsert(dto, user);
        const created = await this.prisma.exam_schedules.create({
            data: {
                campus_id: dto.campus_id,
                academic_year: dto.academic_year.trim(),
                title: dto.title.trim(),
                segment_line: dto.segment_line?.trim() || null,
                reference_no: dto.reference_no?.trim() || null,
                layout: dto.layout ?? null,
                fee_date: new Date(`${feeDate}T00:00:00Z`),
                issue_from: dto.issue_from ? new Date(`${dto.issue_from.slice(0, 10)}T00:00:00Z`) : null,
                notes,
                status: 'DRAFT',
                created_by: this.by(user),
                updated_by: this.by(user),
                exam_schedule_classes: { create: classIds.map((class_id) => ({ class_id })) },
                exam_schedule_papers: { create: this.paperRows(dto) },
            },
            select: { id: true },
        });
        await this.auditLogs.log({
            entity_type: 'EXAM_SCHEDULE',
            entity_id: String(created.id),
            action: 'CREATED',
            new_value: `${dto.title.trim()} (${dto.academic_year}), fee date ${feeDate}`,
            changed_by: this.by(user),
        });
        return this.getSchedule(created.id, user);
    }

    async updateSchedule(id: number, dto: ExamScheduleUpsertDto, user: Staff) {
        const existing = await this.loadSchedule(id, user);
        const { classIds, feeDate, notes } = await this.validateUpsert(dto, user);

        if (existing._count.exam_documents > 0) {
            if (dto.campus_id !== existing.campus_id) {
                throw new ConflictException('Documents have been issued from this schedule, so its campus cannot change');
            }
            const held = await this.prisma.exam_documents.groupBy({
                by: ['class_id'],
                where: { schedule_id: id },
            });
            const dropped = held.map((h) => h.class_id).filter((c) => !classIds.includes(c));
            if (dropped.length) {
                throw new ConflictException('Documents have been issued for a class you removed. Keep the class on the schedule.');
            }
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.exam_schedule_papers.deleteMany({ where: { schedule_id: id } });
            await tx.exam_schedule_classes.deleteMany({ where: { schedule_id: id } });
            await tx.exam_schedules.update({
                where: { id },
                data: {
                    campus_id: dto.campus_id,
                    academic_year: dto.academic_year.trim(),
                    title: dto.title.trim(),
                    segment_line: dto.segment_line?.trim() || null,
                    reference_no: dto.reference_no?.trim() || null,
                    layout: dto.layout ?? null,
                    fee_date: new Date(`${feeDate}T00:00:00Z`),
                    issue_from: dto.issue_from ? new Date(`${dto.issue_from.slice(0, 10)}T00:00:00Z`) : null,
                    notes,
                    updated_by: this.by(user),
                    exam_schedule_classes: { create: classIds.map((class_id) => ({ class_id })) },
                    exam_schedule_papers: { create: this.paperRows(dto) },
                },
            });
        });

        await this.auditLogs.log({
            entity_type: 'EXAM_SCHEDULE',
            entity_id: String(id),
            action: 'UPDATED',
            old_value: `fee date ${iso(existing.fee_date)}, ${existing.exam_schedule_papers.length} papers`,
            new_value: `fee date ${feeDate}, ${dto.papers.length} papers`,
            changed_by: this.by(user),
            note: existing._count.exam_documents > 0 ? `${existing._count.exam_documents} documents already issued` : undefined,
        });
        return this.getSchedule(id, user);
    }

    async setStatus(id: number, status: ExamScheduleStatus, user: Staff) {
        const existing = await this.loadSchedule(id, user);
        if (status === 'PUBLISHED') {
            const withPapers = new Set(existing.exam_schedule_papers.map((p) => p.class_id));
            const empty = existing.exam_schedule_classes.filter((c) => !withPapers.has(c.class_id));
            if (empty.length) {
                throw new BadRequestException(`No papers yet for ${empty.map((c) => c.classes.description).join(', ')}`);
            }
        }
        if (existing.status === status) return this.serializeSchedule(existing);
        await this.prisma.exam_schedules.update({ where: { id }, data: { status, updated_by: this.by(user) } });
        await this.auditLogs.log({
            entity_type: 'EXAM_SCHEDULE',
            entity_id: String(id),
            action: 'UPDATED',
            field: 'status',
            old_value: existing.status,
            new_value: status,
            changed_by: this.by(user),
        });
        return this.getSchedule(id, user);
    }

    async deleteSchedule(id: number, user: Staff) {
        const existing = await this.loadSchedule(id, user);
        if (existing._count.exam_documents > 0) {
            throw new ConflictException('Documents have been issued from this schedule, so it cannot be deleted');
        }
        await this.prisma.exam_schedules.delete({ where: { id } });
        await this.auditLogs.log({
            entity_type: 'EXAM_SCHEDULE',
            entity_id: String(id),
            action: 'DELETED',
            old_value: `${existing.title} (${existing.academic_year})`,
            changed_by: this.by(user),
        });
        return { id };
    }

    // ─── Fee dates ─────────────────────────────────────────────────────────

    /** Change the schedule's fee date. Students with their own date keep it. */
    async setScheduleFeeDate(id: number, feeDate: string, user: Staff) {
        const existing = await this.loadSchedule(id, user);
        const next = feeDate.slice(0, 10);
        const prev = iso(existing.fee_date)!;
        if (prev === next) return this.serializeSchedule(existing);
        await this.prisma.exam_schedules.update({
            where: { id },
            data: { fee_date: new Date(`${next}T00:00:00Z`), updated_by: this.by(user) },
        });
        await this.auditLogs.log({
            entity_type: 'EXAM_SCHEDULE',
            entity_id: String(id),
            action: 'UPDATED',
            field: 'fee_date',
            old_value: prev,
            new_value: next,
            changed_by: this.by(user),
            note: existing._count.exam_documents > 0 ? `${existing._count.exam_documents} documents already issued keep the date they were checked against` : undefined,
        });
        return this.getSchedule(id, user);
    }

    /**
     * The fee dates this schedule's students are billed on, with how much of each
     * is on a voucher, so the picker shows which months the school hasn't billed.
     */
    async feeDateOptions(id: number, user: Staff) {
        const schedule = await this.loadSchedule(id, user);
        const classIds = schedule.exam_schedule_classes.map((c) => c.class_id);
        const scopeWhere = this.scope.whereForStudents(user) as Prisma.studentsWhereInput;
        const ccs = (
            await this.prisma.students.findMany({
                where: { AND: [scopeWhere, { status: 'ENROLLED', campus_id: schedule.campus_id, class_id: { in: classIds } }] },
                select: { cc: true },
            })
        ).map((s) => s.cc);
        if (!ccs.length) return { schedule_fee_date: iso(schedule.fee_date), students: 0, options: [] };

        const rows = await this.prisma.$queryRaw<
            { fee_date: Date; heads: number; not_billed: number; students: number; unpaid_students: number }[]
        >(Prisma.sql`
            SELECT sf.fee_date,
                   COUNT(*)::int AS heads,
                   COUNT(*) FILTER (WHERE sf.status::text = 'NOT_ISSUED')::int AS not_billed,
                   COUNT(DISTINCT sf.student_id)::int AS students,
                   COUNT(DISTINCT sf.student_id) FILTER (
                       WHERE COALESCE(sf.status::text, '') NOT IN ('PAID', 'DISCOUNT', 'WAIVED')
                         AND COALESCE(sf.amount, sf.amount_before_discount, 0) - COALESCE(sf.amount_paid, 0) > 0
                   )::int AS unpaid_students
            FROM public.student_fees sf
            WHERE sf.student_id IN (${Prisma.join(ccs)})
              AND sf.fee_date IS NOT NULL
              AND sf.is_discount = false
              AND sf.is_arrear_surcharge = false
            GROUP BY sf.fee_date
            ORDER BY sf.fee_date DESC
            LIMIT 36
        `);
        return {
            schedule_fee_date: iso(schedule.fee_date),
            students: ccs.length,
            options: rows.map((r) => ({
                fee_date: iso(r.fee_date)!,
                label: feeDateLabel(iso(r.fee_date)!),
                heads: Number(r.heads),
                not_billed: Number(r.not_billed),
                students: Number(r.students),
                unpaid_students: Number(r.unpaid_students),
            })),
        };
    }

    /** Each student's own fee date on this schedule, if any. */
    private async ownFeeDates(scheduleId: number, ccs?: number[]) {
        const rows = await this.prisma.exam_schedule_fee_dates.findMany({
            where: { schedule_id: scheduleId, ...(ccs && { student_id: { in: ccs } }) },
        });
        return new Map(rows.map((r) => [r.student_id, r]));
    }

    /**
     * Give the selected students their own fee date, or (fee_date null) put them
     * back on the schedule's. Students who already hold a document are skipped:
     * theirs was checked when it was issued.
     */
    async setStudentFeeDates(id: number, dto: ExamStudentFeeDatesDto, user: Staff) {
        const schedule = await this.loadSchedule(id, user);
        const ccs = [...new Set(dto.student_ids)];
        const students = await this.loadStudents(ccs, user);
        const problems = ccs
            .map((cc) => ({ cc, why: this.ineligibility(schedule, students.get(cc)) }))
            .filter((p) => p.why);
        if (problems.length) {
            throw new BadRequestException(
                `Cannot change: ${problems.slice(0, 5).map((p) => `C.C. ${p.cc} ${p.why}`).join('; ')}${problems.length > 5 ? ` and ${problems.length - 5} more` : ''}`,
            );
        }
        const held = new Set(
            (await this.prisma.exam_documents.findMany({ where: { schedule_id: id, student_id: { in: ccs } }, select: { student_id: true } })).map(
                (d) => d.student_id,
            ),
        );
        const targets = ccs.filter((cc) => !held.has(cc));
        const before = await this.ownFeeDates(id, targets);
        const scheduleDate = iso(schedule.fee_date)!;
        const next = dto.fee_date ? dto.fee_date.slice(0, 10) : null;
        const reason = dto.reason?.trim() || null;

        await this.prisma.$transaction(async (tx) => {
            if (!next || next === scheduleDate) {
                // Their own date equal to the schedule's is no date of their own.
                await tx.exam_schedule_fee_dates.deleteMany({ where: { schedule_id: id, student_id: { in: targets } } });
                return;
            }
            for (const cc of targets) {
                await tx.exam_schedule_fee_dates.upsert({
                    where: { schedule_id_student_id: { schedule_id: id, student_id: cc } },
                    create: { schedule_id: id, student_id: cc, fee_date: new Date(`${next}T00:00:00Z`), reason, set_by: this.by(user) },
                    update: { fee_date: new Date(`${next}T00:00:00Z`), reason, set_by: this.by(user), set_at: new Date() },
                });
            }
        });

        for (const cc of targets) {
            const prev = before.get(cc);
            const old = prev ? iso(prev.fee_date)! : scheduleDate;
            const now = next ?? scheduleDate;
            if (old === now) continue;
            await this.auditLogs.log({
                entity_type: 'EXAM_SCHEDULE',
                entity_id: String(id),
                action: 'UPDATED',
                field: 'student_fee_date',
                old_value: prev ? old : `${old} (schedule)`,
                new_value: next && next !== scheduleDate ? next : `${scheduleDate} (schedule)`,
                changed_by: this.by(user),
                student_id: cc,
                note: [schedule.title, reason].filter(Boolean).join(': '),
            });
        }
        return { updated: targets.length, skipped_issued: ccs.length - targets.length, fee_date: next };
    }

    /** What the selected students would look like against a fee date, before saving it. */
    async previewFeeDate(id: number, dto: ExamFeeDatePreviewDto, user: Staff) {
        const schedule = await this.loadSchedule(id, user);
        const ccs = [...new Set(dto.student_ids)];
        const students = await this.loadStudents(ccs, user);
        const inScope = ccs.filter((cc) => students.has(cc));
        const held = new Set(
            (await this.prisma.exam_documents.findMany({ where: { schedule_id: id, student_id: { in: inScope } }, select: { student_id: true } })).map(
                (d) => d.student_id,
            ),
        );
        const targets = inScope.filter((cc) => !held.has(cc));
        const feeDate = dto.fee_date.slice(0, 10);
        const dues = await this.duesThrough(targets, feeDate);
        const counts = { CLEARED: 0, NOT_BILLED: 0, BLOCKED: 0 } as Record<Exclude<RosterState, 'ISSUED'>, number>;
        let owed = 0;
        for (const cc of targets) {
            const d = dues.get(cc) ?? NO_DUES;
            counts[rosterState(false, d) as Exclude<RosterState, 'ISSUED'>] += 1;
            owed += totalOwed(d);
        }
        return {
            fee_date: feeDate,
            fee_date_label: feeDateLabel(feeDate),
            is_schedule_date: feeDate === iso(schedule.fee_date),
            students: targets.length,
            skipped_issued: held.size,
            counts,
            owed_total: Math.round(owed * 100) / 100,
        };
    }

    // ─── Dues ──────────────────────────────────────────────────────────────

    /**
     * What each student owes through `cutoff` ('YYYY-MM-DD', inclusive).
     *
     * Heads: the defaulters report's filters (non-discount, not PAID / DISCOUNT /
     * WAIVED, `amount ?? amount_before_discount` minus `amount_paid` above zero),
     * with `fee_date <= cutoff`, whether or not a voucher was ever issued. Heads
     * still NOT_ISSUED are reported apart: the school has to bill them first.
     * Surcharges: unpaid, unwaived rows on live vouchers dated on or before the cutoff.
     */
    async duesThrough(studentIds: number[], cutoff: string): Promise<Map<number, DuesThrough>> {
        const out = new Map<number, DuesThrough>();
        if (!studentIds.length) return out;
        const ids = Prisma.join(studentIds);

        const heads = await this.prisma.$queryRaw<
            { student_id: number; fee_date: Date; outstanding: number; not_billed: number; head_count: number }[]
        >(Prisma.sql`
            SELECT sf.student_id,
                   sf.fee_date,
                   SUM(COALESCE(sf.amount, sf.amount_before_discount, 0) - COALESCE(sf.amount_paid, 0))::float8 AS outstanding,
                   COALESCE(SUM(COALESCE(sf.amount, sf.amount_before_discount, 0) - COALESCE(sf.amount_paid, 0))
                       FILTER (WHERE sf.status::text = 'NOT_ISSUED'), 0)::float8 AS not_billed,
                   COUNT(*)::int AS head_count
            FROM public.student_fees sf
            WHERE sf.student_id IN (${ids})
              AND sf.fee_date IS NOT NULL
              AND sf.fee_date <= ${cutoff}::date
              AND sf.is_arrear_surcharge = false
              AND sf.is_discount = false
              AND COALESCE(sf.status::text, '') NOT IN ('PAID', 'DISCOUNT', 'WAIVED')
              AND COALESCE(sf.amount, sf.amount_before_discount, 0) - COALESCE(sf.amount_paid, 0) > 0
            GROUP BY sf.student_id, sf.fee_date
            ORDER BY sf.student_id, sf.fee_date
        `);

        const surcharges = await this.prisma.$queryRaw<{ student_id: number; outstanding: number }[]>(Prisma.sql`
            SELECT v.student_id,
                   SUM(vas.amount - vas.amount_paid)::float8 AS outstanding
            FROM public.voucher_arrear_surcharges vas
            JOIN public.vouchers v ON v.id = vas.voucher_id
            WHERE v.student_id IN (${ids})
              AND vas.waived = false
              AND vas.amount - vas.amount_paid > 0
              AND v.status IN ('UNPAID', 'OVERDUE', 'PARTIALLY_PAID', 'EXPIRED')
              AND v.fee_date <= ${cutoff}::date
            GROUP BY v.student_id
        `);

        const r2 = (n: number) => Math.round(n * 100) / 100;
        for (const h of heads) {
            const cc = Number(h.student_id);
            const prev = out.get(cc) ?? { ...NO_DUES, months: [] as MonthOwed[] };
            const outstanding = Number(h.outstanding);
            const notBilled = Number(h.not_billed);
            const feeDate = iso(h.fee_date)!;
            prev.months.push({ fee_date: feeDate, billed: r2(outstanding - notBilled), not_billed: r2(notBilled) });
            out.set(cc, {
                ...prev,
                heads_outstanding: r2(prev.heads_outstanding + outstanding),
                not_billed_outstanding: r2(prev.not_billed_outstanding + notBilled),
                head_count: prev.head_count + Number(h.head_count),
                oldest_fee_date: prev.oldest_fee_date && prev.oldest_fee_date < feeDate ? prev.oldest_fee_date : feeDate,
            });
        }
        for (const s of surcharges) {
            const prev = out.get(Number(s.student_id)) ?? { ...NO_DUES, months: [] };
            out.set(Number(s.student_id), { ...prev, surcharge_outstanding: r2(Number(s.outstanding)) });
        }
        return out;
    }

    /** Dues for students who may each have their own fee date: one query per distinct date. */
    private async duesForEach(feeDateOf: Map<number, string>): Promise<Map<number, DuesThrough>> {
        const byDate = new Map<string, number[]>();
        for (const [cc, d] of feeDateOf) byDate.set(d, [...(byDate.get(d) ?? []), cc]);
        const out = new Map<number, DuesThrough>();
        for (const [d, ccs] of byDate) for (const [cc, v] of await this.duesThrough(ccs, d)) out.set(cc, v);
        return out;
    }

    // ─── Roster ────────────────────────────────────────────────────────────

    async roster(id: number, query: ExamRosterQueryDto, user: Staff) {
        const schedule = await this.loadSchedule(id, user);
        const scheduleClassIds = schedule.exam_schedule_classes.map((c) => c.class_id);
        const classIds = query.class_ids?.length ? query.class_ids.filter((c) => scheduleClassIds.includes(c)) : scheduleClassIds;
        const scheduleDate = iso(schedule.fee_date)!;

        const docs = await this.prisma.exam_documents.findMany({ where: { schedule_id: id } });
        const docByStudent = new Map(docs.map((d) => [d.student_id, d]));
        // TAFSD-544: when the parent first opened a released document.
        const openedAt = new Map(
            (
                await this.prisma.exam_document_notifications.findMany({
                    where: { exam_document_id: { in: docs.filter((d) => d.released_at).map((d) => d.id) } },
                    select: { exam_document_id: true, opened_at: true },
                })
            ).map((n) => [n.exam_document_id, n.opened_at]),
        );

        let searchCcs: number[] | null = null;
        if (query.q?.trim()) {
            searchCcs = (await findStudentSearchHits(this.prisma, query.q, 500)).map((h) => h.cc);
            if (!searchCcs.length) return this.rosterResponse(schedule, []);
        }

        const students = await this.prisma.students.findMany({
            where: {
                AND: [
                    this.scope.whereForStudents(user) as Prisma.studentsWhereInput,
                    {
                        OR: [
                            { status: 'ENROLLED', campus_id: schedule.campus_id, class_id: { in: classIds } },
                            // A holder who has since moved still shows, under the class they were issued in.
                            { cc: { in: docs.filter((d) => classIds.includes(d.class_id)).map((d) => d.student_id) } },
                        ],
                    },
                    ...(query.section_ids?.length ? [{ section_id: { in: query.section_ids } }] : []),
                    ...(searchCcs ? [{ cc: { in: searchCcs } }] : []),
                ],
            },
            select: STUDENT_SELECT,
            take: ROSTER_CAP + 1,
        });
        if (students.length > ROSTER_CAP) {
            throw new BadRequestException('Too many students to list at once. Filter by class or section.');
        }

        const own = await this.ownFeeDates(id, students.map((s) => s.cc));
        const feeDateOf = new Map(
            students.map((s) => {
                const doc = docByStudent.get(s.cc);
                // A holder is shown against the date they were checked against when issued.
                const d = doc?.fee_date ? iso(doc.fee_date) : effectiveFeeDate(scheduleDate, own.has(s.cc) ? iso(own.get(s.cc)!.fee_date) : null);
                return [s.cc, d!];
            }),
        );
        const dues = await this.duesForEach(feeDateOf);

        const wantDisciplines = query.disciplines?.map((d) => d.toLowerCase());
        const missing = query.missing ?? [];
        let rows = students
            .map((s) => {
                const d = dues.get(s.cc) ?? NO_DUES;
                const doc = docByStudent.get(s.cc) ?? null;
                const mine = own.get(s.cc) ?? null;
                const father = s.student_guardians.find((g) => g.relationship?.toLowerCase() === 'father')?.guardians?.full_name?.trim();
                return {
                    cc: s.cc,
                    gr_number: s.gr_number,
                    full_name: s.full_name,
                    class_id: s.class_id,
                    class_name: s.classes?.description ?? null,
                    section_id: s.section_id,
                    section_name: s.sections?.description ?? null,
                    student_status: s.status,
                    discipline: s.student_admissions[0]?.discipline?.trim() || null,
                    has_photo: Boolean(s.photo_blue_bg_url || s.photograph_url),
                    has_father: Boolean(father),
                    has_dob: Boolean(s.dob),
                    fee_date: feeDateOf.get(s.cc)!,
                    own_fee_date: mine
                        ? { fee_date: iso(mine.fee_date)!, reason: mine.reason, set_by: mine.set_by, set_at: mine.set_at }
                        : null,
                    state: rosterState(Boolean(doc), d),
                    owed: totalOwed(d),
                    billed_owed: billedOwed(d),
                    not_billed_owed: d.not_billed_outstanding,
                    surcharge_outstanding: d.surcharge_outstanding,
                    oldest_unpaid_fee_date: d.oldest_fee_date,
                    months: d.months,
                    document: doc
                        ? {
                              serial: formatSerial(doc.serial_no),
                              doc_type: doc.doc_type,
                              issued_at: doc.issued_at,
                              issued_by: doc.issued_by,
                              print_count: doc.print_count,
                              last_printed_at: doc.last_printed_at,
                              overridden: Boolean(doc.override_reason),
                              override_reason: doc.override_reason,
                              dues_outstanding_at_issue: Number(doc.dues_outstanding),
                              fee_date: iso(doc.fee_date),
                              released_at: doc.released_at,
                              released_by: doc.released_by,
                              release_message: doc.release_message,
                              parent_opened_at: openedAt.get(doc.id) ?? null,
                          }
                        : null,
                };
            })
            .filter((r) => {
                if (wantDisciplines?.length) {
                    const mineD = r.discipline?.toLowerCase() ?? null;
                    const ok = wantDisciplines.some((w) => (w === 'none' ? !mineD : mineD === w));
                    if (!ok) return false;
                }
                if (query.has_photo === 'true' && !r.has_photo) return false;
                if (query.has_photo === 'false' && r.has_photo) return false;
                if (missing.length) {
                    const gaps = { photo: !r.has_photo, father: !r.has_father, dob: !r.has_dob };
                    if (!missing.some((m) => gaps[m])) return false;
                }
                if (query.fee_date_kinds?.length) {
                    const kind = r.own_fee_date ? 'OWN' : 'SCHEDULE';
                    if (!query.fee_date_kinds.includes(kind)) return false;
                }
                return true;
            });
        rows.sort(
            (a, b) =>
                (a.class_id ?? 0) - (b.class_id ?? 0) ||
                (a.section_name ?? '').localeCompare(b.section_name ?? '') ||
                a.full_name.localeCompare(b.full_name),
        );
        const response = this.rosterResponse(schedule, rows);
        if (query.states?.length) {
            rows = rows.filter((r) => query.states!.includes(r.state));
            response.rows = rows;
        }
        return response;
    }

    private rosterResponse<T extends { state: RosterState; owed: number; billed_owed: number; not_billed_owed: number; own_fee_date: unknown }>(
        schedule: ScheduleRow,
        rows: T[],
    ) {
        const counts = Object.fromEntries(ROSTER_STATES.map((s) => [s, 0])) as Record<RosterState, number>;
        let blockedOwed = 0;
        let notBilledOwed = 0;
        let ownDates = 0;
        for (const r of rows) {
            counts[r.state] += 1;
            if (r.state === 'BLOCKED') blockedOwed += r.owed;
            if (r.state === 'NOT_BILLED') notBilledOwed += r.not_billed_owed;
            if (r.own_fee_date) ownDates += 1;
        }
        const r2 = (n: number) => Math.round(n * 100) / 100;
        return {
            schedule: { ...this.serializeSchedule(schedule), papers: undefined },
            fee_date: iso(schedule.fee_date)!,
            issue_window_open: issueWindowOpen(iso(schedule.issue_from), karachiToday()),
            counts,
            own_fee_dates: ownDates,
            blocked_owed_total: r2(blockedOwed),
            not_billed_owed_total: r2(notBilledOwed),
            rows,
        };
    }

    // ─── Issue ─────────────────────────────────────────────────────────────

    private assertIssuable(schedule: ScheduleRow) {
        if (schedule.status !== 'PUBLISHED') {
            throw new BadRequestException('Publish the schedule before issuing documents from it');
        }
        const from = iso(schedule.issue_from);
        if (!issueWindowOpen(from, karachiToday())) {
            throw new BadRequestException(`Documents for this schedule can be issued from ${dmy(from!, '.')}`);
        }
    }

    private async loadStudents(ccs: number[], user: Staff): Promise<Map<number, StudentRow>> {
        const rows = await this.prisma.students.findMany({
            where: { AND: [this.scope.whereForStudents(user) as Prisma.studentsWhereInput, { cc: { in: ccs } }] },
            select: STUDENT_SELECT,
        });
        return new Map(rows.map((r) => [r.cc, r]));
    }

    /** Why a student without a document can't get one from this schedule, or null. */
    private ineligibility(schedule: ScheduleRow, s: StudentRow | undefined): string | null {
        if (!s) return 'not found or outside your access';
        if (s.status !== 'ENROLLED') return `not enrolled (${s.status})`;
        if (s.campus_id !== schedule.campus_id) return 'on another campus';
        if (!schedule.exam_schedule_classes.some((c) => c.class_id === s.class_id)) return 'their class is not on this schedule';
        return null;
    }

    private async nextSerial(tx: Prisma.TransactionClient, scheduleId: number): Promise<number> {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SERIAL_LOCK_NS}::int, ${scheduleId}::int)`;
        const max = await tx.exam_documents.aggregate({ where: { schedule_id: scheduleId }, _max: { serial_no: true } });
        return (max._max.serial_no ?? 0) + 1;
    }

    /** Each student's fee date for a fresh issue: their own, else the schedule's. */
    private async feeDatesFor(schedule: ScheduleRow, ccs: number[]): Promise<Map<number, string>> {
        const own = await this.ownFeeDates(schedule.id, ccs);
        const scheduleDate = iso(schedule.fee_date)!;
        return new Map(ccs.map((cc) => [cc, effectiveFeeDate(scheduleDate, own.has(cc) ? iso(own.get(cc)!.fee_date) : null)]));
    }

    /**
     * TAFSD-543: one Issue run. Cleared students get a new document, holders a
     * reprint (or, with `skip_holders`, are left alone), and everyone else is
     * skipped with the reason: nothing stops the run. The run is saved as a report
     * (exam_document_runs) whose id goes back with the PDF. When nothing could be
     * printed there is no PDF, only the report.
     */
    async issue(id: number, dto: ExamIssueDto, user: Staff): Promise<IssueOutcome> {
        const schedule = await this.loadSchedule(id, user);
        this.assertIssuable(schedule);
        const ccs = [...new Set(dto.student_ids)];
        const students = await this.loadStudents(ccs, user);
        const existing = await this.prisma.exam_documents.findMany({ where: { schedule_id: id, student_id: { in: ccs } } });
        const held = new Map(existing.map((d) => [d.student_id, d]));
        const classNames = new Map(schedule.exam_schedule_classes.map((c) => [c.class_id, c.classes.description]));
        const scheduleClassIds = schedule.exam_schedule_classes.map((c) => c.class_id);

        const report = new Map<number, RunStudent>();
        const entry = (cc: number, over: Partial<RunStudent>): RunStudent => {
            const s = students.get(cc);
            const doc = held.get(cc);
            const row: RunStudent = {
                cc,
                gr: s?.gr_number ?? null,
                name: s?.full_name ?? `C.C. ${cc}`,
                class: (doc ? classNames.get(doc.class_id) : null) ?? s?.classes?.description ?? null,
                section: s?.sections?.description ?? null,
                outcome: 'SKIPPED',
                reason_code: null,
                reason: null,
                owed: null,
                fee_date: null,
                serial: null,
                gaps: [],
                ...over,
            };
            report.set(cc, row);
            return row;
        };
        const skip = (cc: number, code: SkipCode, reason: string, more: Partial<RunStudent> = {}) =>
            entry(cc, { outcome: 'SKIPPED', reason_code: code, reason, ...more });

        // Holders: a reprint, unless the run was asked to leave them alone.
        const reprint = existing.filter((d) => {
            if (!students.has(d.student_id)) {
                skip(d.student_id, 'NOT_FOUND', SKIP_REASONS.NOT_FOUND);
                return false;
            }
            if (dto.skip_holders) {
                skip(
                    d.student_id,
                    'ALREADY_ISSUED',
                    `Already has #${formatSerial(d.serial_no)}, issued ${dmy(iso(d.issued_at)!, '-')} by ${d.issued_by}. Reprint it from the student's row if needed.`,
                    { serial: formatSerial(d.serial_no) },
                );
                return false;
            }
            return true;
        });

        // Everyone else: their record, then their dues through their fee date.
        const candidates: number[] = [];
        for (const cc of ccs.filter((c) => !held.has(c))) {
            const why = eligibilitySkip(students.get(cc), { campus_id: schedule.campus_id, class_ids: scheduleClassIds });
            if (why) skip(cc, why.code, why.reason);
            else candidates.push(cc);
        }
        const feeDateOf = await this.feeDatesFor(schedule, candidates);
        const dues = await this.duesForEach(feeDateOf);
        const fresh = candidates.filter((cc) => {
            const feeDate = feeDateOf.get(cc)!;
            const why = duesSkip(dues.get(cc) ?? NO_DUES, feeDate);
            if (why) skip(cc, why.code, why.reason, { owed: why.owed, fee_date: feeDate });
            return !why;
        });

        const now = new Date();
        const docs = await this.prisma.$transaction(async (tx) => {
            const created: Awaited<ReturnType<typeof tx.exam_documents.create>>[] = [];
            if (fresh.length) {
                let serial = await this.nextSerial(tx, id);
                for (const cc of fresh) {
                    const s = students.get(cc)!;
                    created.push(
                        await tx.exam_documents.create({
                            data: {
                                schedule_id: id,
                                student_id: cc,
                                doc_type: docTypeForClass(s.class_id!),
                                serial_no: serial++,
                                class_id: s.class_id!,
                                section_id: s.section_id,
                                issued_at: now,
                                issued_by: this.by(user),
                                last_printed_at: now,
                                fee_date: new Date(`${feeDateOf.get(cc)!}T00:00:00Z`),
                            },
                        }),
                    );
                }
            }
            const reprinted = await Promise.all(
                reprint.map((d) =>
                    tx.exam_documents.update({
                        where: { id: d.id },
                        data: { print_count: { increment: 1 }, last_printed_at: now },
                    }),
                ),
            );
            return { created, reprinted };
        });

        for (const d of docs.created) {
            await this.auditLogs.log({
                entity_type: 'EXAM_DOCUMENT',
                entity_id: String(d.id),
                action: 'CREATED',
                field: d.doc_type,
                new_value: `${DOC_TYPE_LABEL[d.doc_type as keyof typeof DOC_TYPE_LABEL]} #${formatSerial(d.serial_no)}, ${schedule.title}, cleared through ${feeDateLabel(iso(d.fee_date)!)}`,
                changed_by: this.by(user),
                student_id: d.student_id,
            });
            entry(d.student_id, { outcome: 'ISSUED', serial: formatSerial(d.serial_no), fee_date: iso(d.fee_date) });
        }
        for (const d of docs.reprinted) {
            entry(d.student_id, { outcome: 'REPRINTED', serial: formatSerial(d.serial_no), fee_date: iso(d.fee_date) });
        }

        const all = [...docs.created, ...docs.reprinted];
        let buffer: Buffer | null = null;
        let error: string | null = null;
        if (all.length) {
            try {
                const out = await this.render(schedule, all, students);
                buffer = out.buffer;
                for (const d of all) {
                    const s = students.get(d.student_id)!;
                    report.get(d.student_id)!.gaps = gapsOf({
                        has_photo_on_file: Boolean(s.photo_blue_bg_url || s.photograph_url),
                        photo_embedded: Boolean(out.photos.get(s.cc)),
                        has_father: Boolean(fatherOf(s).trim()),
                        has_dob: Boolean(s.dob),
                    });
                }
            } catch (e) {
                // The documents are issued and stay issued; reprinting them makes the PDF again.
                this.logger.error(`Exam documents PDF failed for schedule ${id}: ${(e as Error).stack ?? e}`);
                error = 'The documents were issued but the PDF could not be made. Reprint them from the list.';
            }
        }

        const rows = sortRunStudents(ccs.map((cc) => report.get(cc)!).filter(Boolean));
        const runId = await this.saveRun(schedule, rows, error, user);
        const counts = runCounts(rows);
        return {
            buffer,
            filename: this.filename(schedule, all.length === 1 ? students.get(all[0].student_id) : undefined),
            issued: counts.issued,
            reprinted: counts.reprinted,
            skipped: counts.skipped,
            run_id: runId,
            error,
        };
    }

    /**
     * Keep the run's report. Never fails the run: the documents are already
     * issued, so a report that can't be saved (say, before the TAFSD-543
     * migration is applied) only costs the "open it again later".
     */
    private async saveRun(schedule: ScheduleRow, rows: RunStudent[], error: string | null, user: Staff): Promise<number | null> {
        try {
            const run = await this.prisma.exam_document_runs.create({
                data: {
                    schedule_id: schedule.id,
                    label: runLabel(rows),
                    ...runCounts(rows),
                    students: rows as unknown as Prisma.InputJsonValue,
                    error,
                    created_by: this.by(user),
                },
                select: { id: true },
            });
            return run.id;
        } catch (e) {
            this.logger.error(`Could not save the issue run report for schedule ${schedule.id}: ${(e as Error).message}`);
            return null;
        }
    }

    // ─── Run reports (TAFSD-543) ───────────────────────────────────────────

    async listRuns(id: number, user: Staff) {
        await this.loadSchedule(id, user);
        const runs = await this.prisma.exam_document_runs.findMany({
            where: { schedule_id: id },
            orderBy: { created_at: 'desc' },
            take: 100,
            select: {
                id: true,
                label: true,
                requested: true,
                issued: true,
                reprinted: true,
                skipped: true,
                with_gaps: true,
                error: true,
                created_by: true,
                created_at: true,
            },
        });
        return runs;
    }

    private async loadRun(id: number, runId: number, user: Staff) {
        const schedule = await this.loadSchedule(id, user);
        const run = await this.prisma.exam_document_runs.findFirst({ where: { id: runId, schedule_id: id } });
        if (!run) throw new NotFoundException('Issue run not found');
        // The report was written for whoever ran it; a viewer with a narrower scope
        // sees only the students they can see today.
        const rows = (run.students as unknown as RunStudent[]) ?? [];
        const visible = new Set(
            (
                await this.prisma.students.findMany({
                    where: {
                        AND: [this.scope.whereForStudents(user) as Prisma.studentsWhereInput, { cc: { in: rows.map((r) => r.cc) } }],
                    },
                    select: { cc: true },
                })
            ).map((s) => s.cc),
        );
        // A NOT_FOUND row carries only the C.C. that was typed, so everyone sees it.
        const students = rows.filter((r) => visible.has(r.cc) || r.reason_code === 'NOT_FOUND');
        return { schedule, run, students };
    }

    async getRun(id: number, runId: number, user: Staff) {
        const { run, students } = await this.loadRun(id, runId, user);
        return {
            id: run.id,
            schedule_id: run.schedule_id,
            label: run.label,
            created_by: run.created_by,
            created_at: run.created_at,
            error: run.error,
            counts: runCounts(students),
            hidden: (run.students as unknown as RunStudent[]).length - students.length,
            students: sortRunStudents(students),
        };
    }

    async exportRun(id: number, runId: number, user: Staff): Promise<{ buffer: Buffer; filename: string }> {
        const { schedule, run, students } = await this.loadRun(id, runId, user);
        const createdAt = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Karachi',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        }).format(run.created_at);
        const buffer = await buildRunWorkbook({
            scheduleTitle: schedule.title,
            academicYear: schedule.academic_year,
            campus: schedule.campuses.campus_name,
            label: run.label,
            createdBy: run.created_by,
            createdAt,
            students,
        });
        const base = `${schedule.title}-${schedule.academic_year}-issue-report-${run.id}`.replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-');
        return { buffer, filename: `${base}.xlsx` };
    }

    /** Issue to one student who still owes dues, with a recorded reason. */
    async override(id: number, dto: ExamOverrideDto, user: Staff) {
        const schedule = await this.loadSchedule(id, user);
        this.assertIssuable(schedule);
        const reason = dto.reason.trim();
        if (reason.length < 5) throw new BadRequestException('Give a reason for the override');

        const students = await this.loadStudents([dto.student_id], user);
        const s = students.get(dto.student_id);
        const why = this.ineligibility(schedule, s);
        if (why) throw new BadRequestException(`Cannot issue: C.C. ${dto.student_id} ${why}`);
        const already = await this.prisma.exam_documents.findUnique({
            where: { schedule_id_student_id: { schedule_id: id, student_id: dto.student_id } },
        });
        if (already) throw new ConflictException('This student already has a document from this schedule. Reprint it instead.');

        const cutoff = (await this.feeDatesFor(schedule, [dto.student_id])).get(dto.student_id)!;
        const dues = (await this.duesThrough([dto.student_id], cutoff)).get(dto.student_id) ?? NO_DUES;
        const owed = totalOwed(dues);
        if (owed <= 0) throw new BadRequestException('This student has no dues outstanding. Issue normally.');

        const now = new Date();
        const doc = await this.prisma.$transaction(async (tx) =>
            tx.exam_documents.create({
                data: {
                    schedule_id: id,
                    student_id: dto.student_id,
                    doc_type: docTypeForClass(s!.class_id!),
                    serial_no: await this.nextSerial(tx, id),
                    class_id: s!.class_id!,
                    section_id: s!.section_id,
                    issued_at: now,
                    issued_by: this.by(user),
                    last_printed_at: now,
                    dues_outstanding: new Prisma.Decimal(owed),
                    fee_date: new Date(`${cutoff}T00:00:00Z`),
                    override_reason: reason,
                    overridden_by: this.by(user),
                },
            }),
        );

        await this.auditLogs.log({
            entity_type: 'EXAM_DOCUMENT',
            entity_id: String(doc.id),
            action: 'CREATED',
            field: 'DUES_OVERRIDE',
            new_value: `${DOC_TYPE_LABEL[doc.doc_type as keyof typeof DOC_TYPE_LABEL]} #${formatSerial(doc.serial_no)} issued with Rs ${owed.toLocaleString('en-US')} owed through ${feeDateLabel(cutoff)}${dues.not_billed_outstanding > 0 ? ` (Rs ${dues.not_billed_outstanding.toLocaleString('en-US')} never billed)` : ''}`,
            changed_by: this.by(user),
            student_id: dto.student_id,
            note: reason,
        });

        const { buffer } = await this.render(schedule, [doc], students);
        return { buffer, filename: this.filename(schedule, s), issued: 1, reprinted: 0 };
    }

    // ─── Release to the parent app (TAFSD-544) ─────────────────────────────

    /**
     * Release issued documents to the parent app: each family gets a push and a
     * document card on its Notice Board. Students without a document, already
     * released, or with no parent account are reported, not refused.
     */
    async release(id: number, dto: ExamReleaseDto, user: Staff) {
        const schedule = await this.loadSchedule(id, user);
        const message = cleanReleaseMessage(dto.message);
        const ccs = [...new Set(dto.student_ids)];
        const students = await this.loadStudents(ccs, user);
        const docs = await this.prisma.exam_documents.findMany({ where: { schedule_id: id, student_id: { in: ccs } } });
        const docOf = new Map(docs.map((d) => [d.student_id, d]));
        const families = new Map(
            (
                await this.prisma.students.findMany({
                    where: { cc: { in: [...students.keys()] }, deleted_at: null },
                    select: { cc: true, family_id: true },
                })
            ).map((s) => [s.cc, s.family_id]),
        );

        const rows = ccs.map((cc) => {
            const s = students.get(cc);
            const d = docOf.get(cc);
            const outcome = releaseOutcome({
                found: Boolean(s),
                hasDocument: Boolean(d),
                releasedAt: d?.released_at ?? null,
                familyId: families.get(cc) ?? null,
            });
            return { cc, name: s?.full_name ?? `C.C. ${cc}`, outcome, doc: d, familyId: families.get(cc) ?? null };
        });

        const now = new Date();
        const toRelease = rows.filter((r) => r.outcome === 'RELEASED');
        const created = await this.prisma.$transaction(async (tx) => {
            const out: { cc: number; familyId: number; notificationId: number; documentId: number; title: string; body: string }[] = [];
            for (const r of toRelease) {
                const doc = r.doc!;
                // Another release may have landed between the read and here.
                const claimed = await tx.exam_documents.updateMany({
                    where: { id: doc.id, released_at: null },
                    data: { released_at: now, released_by: this.by(user), release_message: message },
                });
                if (!claimed.count) {
                    r.outcome = 'ALREADY_RELEASED';
                    continue;
                }
                const docType = doc.doc_type as ExamDocType;
                const title = releaseTitle(docType);
                const body = releaseBody(r.name, schedule.title, docType, message);
                const n = await tx.exam_document_notifications.create({
                    data: { family_id: r.familyId!, student_cc: r.cc, exam_document_id: doc.id, doc_type: docType, title, body, message },
                    select: { id: true },
                });
                out.push({ cc: r.cc, familyId: r.familyId!, notificationId: n.id, documentId: doc.id, title, body });
            }
            return out;
        });

        for (const c of created) {
            await this.auditLogs.log({
                entity_type: 'EXAM_DOCUMENT',
                entity_id: String(c.documentId),
                action: 'UPDATED',
                field: 'RELEASED_TO_APP',
                new_value: `Released to the parent app${message ? ` with the message: ${message}` : ''}`,
                changed_by: this.by(user),
                student_id: c.cc,
            });
            // The card is already on the Notice Board; a failed push only costs the alert.
            try {
                await this.fcm.sendToFamily(c.familyId, c.title, c.body, {
                    type: 'exam_document',
                    notification_id: String(c.notificationId),
                    exam_document_id: String(c.documentId),
                    student_cc: String(c.cc),
                    title: c.title,
                    body: c.body,
                });
            } catch (e) {
                this.logger.warn(`Exam document push failed for family ${c.familyId}: ${(e as Error).message}`);
            }
        }

        const count = (o: ReleaseOutcome) => rows.filter((r) => r.outcome === o).length;
        return {
            released: count('RELEASED'),
            already_released: count('ALREADY_RELEASED'),
            not_issued: count('NOT_ISSUED'),
            no_family: count('NO_FAMILY'),
            not_found: count('NOT_FOUND'),
            students: rows.map((r) => ({ cc: r.cc, name: r.name, outcome: r.outcome, reason: RELEASE_OUTCOME_LABEL[r.outcome] })),
        };
    }

    /**
     * Undo a release: the card leaves the family's Notice Board and the document
     * goes back to "not released". No push. Releasing again later sends a new one.
     */
    async unrelease(id: number, dto: ExamUnreleaseDto, user: Staff) {
        await this.loadSchedule(id, user);
        const ccs = [...new Set(dto.student_ids)];
        const students = await this.loadStudents(ccs, user);
        const docs = await this.prisma.exam_documents.findMany({
            where: { schedule_id: id, student_id: { in: [...students.keys()] }, released_at: { not: null } },
        });
        const released = new Map(docs.map((d) => [d.student_id, d]));

        await this.prisma.$transaction(async (tx) => {
            for (const d of docs) {
                await tx.exam_document_notifications.deleteMany({ where: { exam_document_id: d.id } });
                await tx.exam_documents.update({
                    where: { id: d.id },
                    data: { released_at: null, released_by: null, release_message: null },
                });
            }
        });
        for (const d of docs) {
            await this.auditLogs.log({
                entity_type: 'EXAM_DOCUMENT',
                entity_id: String(d.id),
                action: 'UPDATED',
                field: 'RELEASED_TO_APP',
                old_value: `Released ${d.released_at!.toISOString()} by ${d.released_by ?? 'unknown'}`,
                new_value: 'Release undone: removed from the parent app',
                changed_by: this.by(user),
                student_id: d.student_id,
            });
        }

        const outcome = (cc: number) => (!students.has(cc) ? 'NOT_FOUND' : released.has(cc) ? 'UNRELEASED' : 'NOT_RELEASED');
        const rows = ccs.map((cc) => ({ cc, name: students.get(cc)?.full_name ?? `C.C. ${cc}`, outcome: outcome(cc) }));
        return {
            unreleased: rows.filter((r) => r.outcome === 'UNRELEASED').length,
            not_released: rows.filter((r) => r.outcome === 'NOT_RELEASED').length,
            not_found: rows.filter((r) => r.outcome === 'NOT_FOUND').length,
            students: rows,
        };
    }

    // ─── The parent app's side (TAFSD-544) ─────────────────────────────────

    /** The family's exam document cards, newest first, 20 at a time. */
    async familyNotifications(familyId: number, cursor?: number) {
        const rows = await this.prisma.exam_document_notifications.findMany({
            where: { family_id: familyId, ...(cursor ? { id: { lt: cursor } } : {}) },
            orderBy: { id: 'desc' },
            take: 20,
            include: {
                students: { select: { cc: true, full_name: true } },
                exam_documents: {
                    select: {
                        id: true,
                        serial_no: true,
                        class_id: true,
                        section_id: true,
                        classes: { select: { description: true } },
                        exam_schedules: {
                            select: { id: true, title: true, academic_year: true, campuses: { select: { campus_name: true } } },
                        },
                    },
                },
            },
        });
        if (!rows.length) return [];

        const sectionIds = [...new Set(rows.map((r) => r.exam_documents.section_id).filter((x): x is number => x != null))];
        const sections = new Map(
            (await this.prisma.sections.findMany({ where: { id: { in: sectionIds } }, select: { id: true, description: true } })).map((s) => [
                s.id,
                s.description,
            ]),
        );
        const firstPapers = await this.prisma.exam_schedule_papers.groupBy({
            by: ['schedule_id', 'class_id'],
            where: { OR: rows.map((r) => ({ schedule_id: r.exam_documents.exam_schedules.id, class_id: r.exam_documents.class_id })) },
            _min: { paper_date: true },
        });
        const firstPaper = new Map(firstPapers.map((p) => [`${p.schedule_id}:${p.class_id}`, iso(p._min.paper_date)]));

        return rows.map((r) => {
            const d = r.exam_documents;
            const soe = r.doc_type === 'STATEMENT_OF_ENTRY';
            return {
                id: r.id,
                family_id: r.family_id,
                student_cc: r.student_cc,
                exam_document_id: r.exam_document_id,
                doc_type: r.doc_type,
                title: r.title,
                body: r.body,
                message: r.message,
                read_at: r.read_at,
                opened_at: r.opened_at,
                created_at: r.created_at,
                student: {
                    cc: r.students.cc,
                    full_name: r.students.full_name,
                    class_name: d.classes?.description ?? null,
                    section_name: d.section_id != null ? sections.get(d.section_id) ?? null : null,
                },
                document: {
                    serial: formatSerial(d.serial_no),
                    assessment: d.exam_schedules.title,
                    academic_year: d.exam_schedules.academic_year,
                    first_paper_date: firstPaper.get(`${d.exam_schedules.id}:${d.class_id}`) ?? null,
                    centre: soe ? CAMBRIDGE_CENTRE : null,
                    // A statement of entry has the notice to candidates on its back.
                    pages: soe ? 2 : 1,
                    campus_name: d.exam_schedules.campuses.campus_name,
                },
            };
        });
    }

    async markFamilyNotificationRead(id: number, familyId: number) {
        const n = await this.prisma.exam_document_notifications.findFirst({ where: { id, family_id: familyId } });
        if (!n) throw new NotFoundException('Notification not found');
        return this.prisma.exam_document_notifications.update({ where: { id }, data: { read_at: n.read_at ?? new Date() } });
    }

    /** The document's current PDF for the family that holds the card. Records the first open. */
    async familyNotificationPdf(id: number, familyId: number): Promise<{ buffer: Buffer; filename: string }> {
        const n = await this.prisma.exam_document_notifications.findFirst({
            where: { id, family_id: familyId },
            include: { exam_documents: true },
        });
        if (!n) throw new NotFoundException('Document not found');
        const doc = n.exam_documents;
        const schedule = await this.prisma.exam_schedules.findUnique({ where: { id: doc.schedule_id }, include: SCHEDULE_INCLUDE });
        const student = await this.prisma.students.findUnique({ where: { cc: doc.student_id }, select: STUDENT_SELECT });
        if (!schedule || !student) throw new NotFoundException('Document not found');

        const { buffer } = await this.render(schedule, [doc], new Map([[student.cc, student]]));
        const at = new Date();
        await this.prisma.exam_document_notifications.update({
            where: { id },
            data: { opened_at: n.opened_at ?? at, read_at: n.read_at ?? at },
        });
        return { buffer, filename: this.filename(schedule, student) };
    }

    // ─── PDF ───────────────────────────────────────────────────────────────

    private filename(schedule: ScheduleRow, single?: StudentRow) {
        const base = `${schedule.title}-${schedule.academic_year}`.replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-');
        return single ? `${base}-CC${single.cc}.pdf` : `${base}.pdf`;
    }

    private async photoDataUri(s: StudentRow): Promise<string | null> {
        const url = s.photo_blue_bg_url || s.photograph_url;
        if (!url) return null;
        try {
            const { buffer, mime } = await this.storage.getFile(this.storage.extractKeyFromUrl(url));
            if (!/^image\/(png|jpe?g)$/.test(mime)) return null;
            return `data:${mime};base64,${buffer.toString('base64')}`;
        } catch (e) {
            this.logger.warn(`Could not embed photo for C.C. ${s.cc}: ${(e as Error).message}`);
            return null;
        }
    }

    private async photos(students: StudentRow[]): Promise<Map<number, string | null>> {
        const out = new Map<number, string | null>();
        for (let i = 0; i < students.length; i += PHOTO_CONCURRENCY) {
            const batch = students.slice(i, i + PHOTO_CONCURRENCY);
            const got = await Promise.all(batch.map((s) => this.photoDataUri(s)));
            batch.forEach((s, j) => out.set(s.cc, got[j]));
        }
        return out;
    }

    private async render(
        schedule: ScheduleRow,
        docs: { student_id: number; class_id: number; section_id: number | null; serial_no: number; issued_at: Date; doc_type: string }[],
        students: Map<number, StudentRow>,
    ): Promise<{ buffer: Buffer; photos: Map<number, string | null> }> {
        const sectionIds = [...new Set(docs.map((d) => d.section_id).filter((x): x is number => x != null))];
        const sections = new Map(
            (await this.prisma.sections.findMany({ where: { id: { in: sectionIds } }, select: { id: true, description: true } })).map(
                (x) => [x.id, x.description],
            ),
        );
        const classNames = new Map(schedule.exam_schedule_classes.map((c) => [c.class_id, c.classes.description]));
        const ordered = [...docs].sort(
            (a, b) =>
                a.class_id - b.class_id ||
                (sections.get(a.section_id ?? -1) ?? '').localeCompare(sections.get(b.section_id ?? -1) ?? '') ||
                (students.get(a.student_id)?.full_name ?? '').localeCompare(students.get(b.student_id)?.full_name ?? ''),
        );
        const photos = await this.photos(ordered.map((d) => students.get(d.student_id)!).filter(Boolean));
        const pages = ordered.map((d) => this.page(schedule, d, students.get(d.student_id)!, classNames, sections, photos));
        const element = React.createElement(ExamDocumentsPDF, { pages, title: schedule.title }) as any;
        return { buffer: Buffer.from(await renderToBuffer(element)), photos };
    }

    private page(
        schedule: ScheduleRow,
        doc: { class_id: number; section_id: number | null; serial_no: number; issued_at: Date },
        s: StudentRow,
        classNames: Map<number, string>,
        sections: Map<number, string>,
        photos: Map<number, string | null>,
    ): ExamDocPage {
        const father = fatherOf(s);
        return buildExamDocPage({
            schedule: {
                title: schedule.title,
                segmentLine: schedule.segment_line,
                academicYear: schedule.academic_year,
                notes: schedule.notes,
                campusName: schedule.campuses.campus_name,
                campusAddress: schedule.campuses.address,
                papers: schedule.exam_schedule_papers,
            },
            classId: doc.class_id,
            className: classNames.get(doc.class_id) ?? s.classes?.description ?? '',
            sectionName: doc.section_id != null ? sections.get(doc.section_id) ?? null : null,
            serialNo: doc.serial_no,
            issuedAt: doc.issued_at,
            student: {
                cc: s.cc,
                gr: s.gr_number,
                fullName: s.full_name,
                father,
                dob: s.dob,
                gender: s.gender,
                discipline: s.student_admissions[0]?.discipline ?? null,
            },
            photo: photos.get(s.cc) ?? null,
        });
    }
}
