import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { EcChargesService } from '../charges/ec-charges.service';
import { EC_DEFAULT_VALIDITY_DAYS } from '../ec.constants';
import { actorNameOf, actorOf, normalizeEcAcademicYear, normalizeEcMonths } from '../ec-common.util';
import { addDays, dateKey, ecPeriodLabel, parseDateKey, todayPktKey } from '../ec-dates.util';
import { createVoucherInTx, resolveEcBank } from '../ec-issue';
import { EcBulkIssueDto, EcBulkIssueFilterDto } from './dto/ec-bulk.dto';

const CHARGE_SELECT = {
    id: true,
    student_id: true,
    academic_year: true,
    period: true,
    amount: true,
    ec_fee_heads: { select: { name: true, sort_order: true } },
} as const;
type ChargeRow = Prisma.ec_student_chargesGetPayload<{ select: typeof CHARGE_SELECT }>;

const PREVIEW_ROWS = 300;

/**
 * TAFSD-605: bulk extracurricular vouchers. One voucher per (student, academic
 * year) holding that student's unissued charges for the chosen heads and
 * months; pick one month to get monthly vouchers. Nothing is folded into an
 * older voucher and nothing is voided.
 *
 * No background job: the client sends the eligible students in chunks of up
 * to 100, one call after another. Each call re-derives what is eligible, issues
 * each voucher in its own transaction through createVoucherInTx, and reports
 * per student. A retried chunk issues only what is still unissued, and a
 * deploy mid-run fails at most one chunk.
 */
@Injectable()
export class EcVoucherBulkService {
    private readonly logger = new Logger(EcVoucherBulkService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly auditLogs: AuditLogsService,
        private readonly charges: EcChargesService,
    ) {}

    private chargeWhere(dto: EcBulkIssueFilterDto, ccs: number[]): Prisma.ec_student_chargesWhereInput {
        return {
            student_id: { in: ccs },
            status: 'NOT_ISSUED',
            current_voucher_id: null,
            amount: { gt: 0 },
            ...(dto.fee_head_ids?.length ? { fee_head_id: { in: dto.fee_head_ids } } : {}),
            ...(dto.months?.length ? { target_month: { in: normalizeEcMonths(dto.months) } } : {}),
            ...(dto.academic_years?.length ? { academic_year: { in: dto.academic_years.map(normalizeEcAcademicYear) } } : {}),
        };
    }

    /** Group a student's charges into one voucher per academic year. */
    private groups(charges: ChargeRow[]) {
        const byKey = new Map<string, ChargeRow[]>();
        for (const c of charges) {
            const key = `${c.student_id}|${c.academic_year}`;
            byKey.set(key, [...(byKey.get(key) ?? []), c]);
        }
        return byKey;
    }

    async preview(user: IJwtStaffPayload, dto: EcBulkIssueFilterDto) {
        const students = await this.charges.targetStudents(user, dto);
        const byCc = new Map(students.map((s) => [s.cc, s]));
        const charges = students.length
            ? await this.prisma.ec_student_charges.findMany({ where: this.chargeWhere(dto, students.map((s) => s.cc)), select: CHARGE_SELECT, orderBy: [{ student_id: 'asc' }, { period: 'asc' }] })
            : [];
        const groups = this.groups(charges);
        const rows = [...groups.entries()].map(([key, list]) => {
            const [cc, year] = [Number(key.split('|')[0]), key.split('|')[1]];
            const s = byCc.get(cc)!;
            return {
                cc,
                full_name: s.full_name,
                gr_number: s.gr_number,
                campus_name: s.campuses?.campus_name ?? null,
                class_name: s.classes?.description ?? null,
                section_name: s.sections?.description ?? null,
                academic_year: year,
                charges: list.length,
                total: list.reduce((n, c) => n + Number(c.amount), 0),
                description: list.map((c) => `${c.ec_fee_heads.name} (${ecPeriodLabel(c.period)})`).join(', '),
            };
        });
        const eligible = [...new Set(rows.map((r) => r.cc))];
        return {
            students_matched: students.length,
            students_requested: dto.student_ids?.length ?? null,
            students_with_charges: eligible.length,
            students_without_charges: students.length - eligible.length,
            vouchers_to_issue: rows.length,
            total_amount: rows.reduce((n, r) => n + r.total, 0),
            eligible_student_ids: eligible,
            rows: rows.slice(0, PREVIEW_ROWS),
            rows_truncated: rows.length > PREVIEW_ROWS,
        };
    }

    async issue(user: IJwtStaffPayload, dto: EcBulkIssueDto) {
        const issueDate = parseDateKey(dto.issue_date, 'Issue date');
        const expiryDate = dto.expiry_date ? parseDateKey(dto.expiry_date, 'Valid-till date') : addDays(issueDate, EC_DEFAULT_VALIDITY_DAYS);
        if (expiryDate < issueDate) throw new BadRequestException('The valid-till date is before the issue date');
        if (dateKey(expiryDate) < todayPktKey()) throw new BadRequestException('The valid-till date has already passed');
        const bank = await resolveEcBank(this.prisma, dto.bank_account_id);

        // The chunk is narrowed by the same filters and scope as the preview (only
        // its own students are loaded): a C.C. outside them is reported, never issued.
        const chunk = [...new Set(dto.chunk_student_ids)];
        const allowed = dto.student_ids?.length ? chunk.filter((cc) => dto.student_ids!.includes(cc)) : chunk;
        const students = allowed.length ? await this.charges.targetStudents(user, { ...dto, student_ids: allowed }) : [];
        const byCc = new Map(students.map((s) => [s.cc, s]));
        const charges = students.length
            ? await this.prisma.ec_student_charges.findMany({ where: this.chargeWhere(dto, students.map((s) => s.cc)), select: CHARGE_SELECT, orderBy: [{ student_id: 'asc' }, { period: 'asc' }] })
            : [];
        const groups = this.groups(charges);

        type Result =
            | { cc: number; status: 'ISSUED'; voucher_id: number; voucher_number: string; academic_year: string; total: number }
            | { cc: number; status: 'SKIPPED' | 'FAILED'; reason: string; academic_year?: string };
        const results: Result[] = [];
        const by = actorOf(user);
        const byName = actorNameOf(user);

        for (const cc of chunk) {
            const s = byCc.get(cc);
            if (!s) {
                results.push({ cc, status: 'SKIPPED', reason: 'Not an enrolled student in this selection you can see' });
                continue;
            }
            if (!s.campus_id || !s.class_id) {
                results.push({ cc, status: 'SKIPPED', reason: 'Not placed in a campus and class' });
                continue;
            }
            const mine = [...groups.entries()].filter(([key]) => Number(key.split('|')[0]) === cc);
            if (!mine.length) {
                results.push({ cc, status: 'SKIPPED', reason: 'Nothing left to issue' });
                continue;
            }
            for (const [key, list] of mine) {
                const year = key.split('|')[1];
                const ordered = [...list].sort(
                    (a, b) => a.ec_fee_heads.sort_order - b.ec_fee_heads.sort_order || a.period.getTime() - b.period.getTime() || a.id - b.id,
                );
                try {
                    const v = await this.prisma.$transaction(
                        (tx) =>
                            createVoucherInTx(tx, {
                                student: { cc, campus_id: s.campus_id!, class_id: s.class_id!, section_id: s.section_id },
                                academicYear: year,
                                issueDate,
                                expiryDate,
                                bank,
                                lines: ordered.map((c, i) => ({ charge_id: c.id, description: `${c.ec_fee_heads.name} (${ecPeriodLabel(c.period)})`, amount: Number(c.amount), sort_order: i })),
                                expectCurrentVoucherId: null,
                                createdBy: by,
                                generatedByName: byName,
                                bulkRunId: dto.run_id,
                            }),
                        { timeout: 20_000 },
                    );
                    results.push({ cc, status: 'ISSUED', voucher_id: v.id, voucher_number: v.voucher_number, academic_year: year, total: ordered.reduce((n, c) => n + Number(c.amount), 0) });
                } catch (err) {
                    const reason = (err as { message?: string })?.message ?? 'Failed';
                    this.logger.warn(`Bulk EC issue for ${cc} (${year}) failed: ${reason}`);
                    results.push({ cc, status: 'FAILED', reason, academic_year: year });
                }
            }
        }

        const issued = results.filter((r): r is Extract<Result, { status: 'ISSUED' }> => r.status === 'ISSUED');
        if (issued.length) {
            await this.auditLogs.logGroup(
                {
                    entity_type: 'EC_VOUCHER',
                    entity_id: `bulk:${dto.run_id}`,
                    action: 'CREATED',
                    section: 'finance',
                    new_value: JSON.stringify({ run_id: dto.run_id, issued: issued.length, total: issued.reduce((n, r) => n + r.total, 0), issue_date: dateKey(issueDate), expiry_date: dateKey(expiryDate) }),
                    changed_by: by,
                },
                issued.map((r) => ({
                    entity_type: 'EC_VOUCHER',
                    entity_id: String(r.voucher_id),
                    action: 'CREATED',
                    section: 'finance',
                    student_id: r.cc,
                    note: `${r.voucher_number} (${r.academic_year}) Rs ${r.total}, bulk run ${dto.run_id}`,
                })),
            );
        }
        return {
            run_id: dto.run_id,
            issued: issued.length,
            skipped: results.filter((r) => r.status === 'SKIPPED').length,
            failed: results.filter((r) => r.status === 'FAILED').length,
            results,
        };
    }
}
