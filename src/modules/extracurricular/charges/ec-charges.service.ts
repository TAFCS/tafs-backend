import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ScopeService } from '../../../common/scope/scope.service';
import { getClassTermMap } from '../../../common/utils/class-terms.util';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { loadClassAmounts } from '../ec-class-amounts';
import { actorOf, normalizeEcAcademicYear, normalizeEcMonths } from '../ec-common.util';
import { dateKey, ecPeriodLabel, ecPeriodOf } from '../ec-dates.util';
import {
    EC_BULK_CHARGE_MAX_STUDENTS,
    EcBulkAssignDto,
    EcBulkRemoveDto,
    EcBulkTargetDto,
    SaveEcStudentChargesDto,
} from './dto/ec-charges.dto';

const STUDENT_SELECT = {
    cc: true,
    full_name: true,
    gr_number: true,
    status: true,
    deleted_at: true,
    campus_id: true,
    class_id: true,
    section_id: true,
    campuses: { select: { campus_name: true } },
    classes: { select: { description: true, segment_id: true } },
    sections: { select: { description: true } },
} as const;
type StudentRow = Prisma.studentsGetPayload<{ select: typeof STUDENT_SELECT }>;

const CHARGE_SELECT = {
    id: true,
    student_id: true,
    fee_head_id: true,
    academic_year: true,
    target_month: true,
    period: true,
    amount: true,
    amount_paid: true,
    waived_amount: true,
    status: true,
    current_voucher_id: true,
    source: true,
    remarks: true,
    created_by: true,
    created_at: true,
    ec_fee_heads: { select: { name: true, frequency: true, sort_order: true } },
    current_voucher: { select: { id: true, voucher_number: true } },
} as const;
type ChargeRow = Prisma.ec_student_chargesGetPayload<{ select: typeof CHARGE_SELECT }>;

export type EcChargeLockReason = 'ON_VOUCHER' | 'PAID' | 'WAIVED';

/** Why a charge can no longer be edited or removed, or null while it is free. */
export function chargeLockReason(c: {
    status: string;
    amount_paid: Prisma.Decimal | number;
    waived_amount: Prisma.Decimal | number;
    current_voucher_id: number | null;
}): EcChargeLockReason | null {
    if (c.status === 'WAIVED' || Number(c.waived_amount) > 0) return 'WAIVED';
    if (Number(c.amount_paid) > 0 || c.status === 'PAID' || c.status === 'PARTIALLY_PAID') return 'PAID';
    if (c.current_voucher_id != null || c.status !== 'NOT_ISSUED') return 'ON_VOUCHER';
    return null;
}

const LOCK_TEXT: Record<EcChargeLockReason, string> = {
    ON_VOUCHER: 'on a voucher',
    PAID: 'paid',
    WAIVED: 'waived',
};

const studentView = (s: StudentRow) => ({
    cc: s.cc,
    full_name: s.full_name,
    gr_number: s.gr_number,
    status: s.status,
    campus_id: s.campus_id,
    campus_name: s.campuses?.campus_name ?? null,
    class_id: s.class_id,
    class_name: s.classes?.description ?? null,
    section_id: s.section_id,
    section_name: s.sections?.description ?? null,
});

const chargeView = (c: ChargeRow) => {
    const amount = Number(c.amount);
    const paid = Number(c.amount_paid);
    const waived = Number(c.waived_amount);
    return {
        id: c.id,
        fee_head_id: c.fee_head_id,
        fee_head_name: c.ec_fee_heads.name,
        frequency: c.ec_fee_heads.frequency,
        academic_year: c.academic_year,
        target_month: c.target_month,
        period: dateKey(c.period),
        period_label: ecPeriodLabel(c.period),
        amount,
        amount_paid: paid,
        waived_amount: waived,
        balance: Math.max(amount - paid - waived, 0),
        status: c.status,
        source: c.source,
        remarks: c.remarks,
        locked_reason: chargeLockReason(c),
        current_voucher: c.current_voucher ? { id: c.current_voucher.id, voucher_number: c.current_voucher.voucher_number } : null,
        created_by: c.created_by,
        created_at: c.created_at,
    };
};

const PREVIEW_ROWS = 300;

/**
 * TAFSD-605: what each student is charged for extracurricular heads, the EC
 * twin of Student Overrides. A charge is one head in one month for one
 * student. While it is NOT_ISSUED it can be edited or removed freely; once on
 * a voucher (or paid, or waived) it is locked here and changes only through the
 * voucher.
 */
@Injectable()
export class EcChargesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly scope: ScopeService,
        private readonly auditLogs: AuditLogsService,
    ) {}

    // ─── Students ─────────────────────────────────────────────────────────

    /** A student the caller may see, or 404 (never 403: that would confirm the C.C. exists). */
    async loadVisibleStudent(user: IJwtStaffPayload, cc: number): Promise<StudentRow> {
        const s = await this.prisma.students.findUnique({ where: { cc }, select: STUDENT_SELECT });
        if (!s || !this.scope.canSeeStudent(user, { ...s, segment_id: s.classes?.segment_id ?? null })) {
            throw new NotFoundException(`Student ${cc} not found`);
        }
        return s;
    }

    /**
     * The students a bulk operation reaches: enrolled, not deleted, inside the
     * caller's scope, narrowed by explicit C.C.s and/or placement filters (at
     * least one of them, so nobody charges the whole school by accident).
     */
    private async targetStudents(user: IJwtStaffPayload, dto: EcBulkTargetDto): Promise<StudentRow[]> {
        const has = (a?: number[]) => (a?.length ?? 0) > 0;
        if (!has(dto.student_ids) && !has(dto.campus_ids) && !has(dto.class_ids) && !has(dto.section_ids)) {
            throw new BadRequestException('Pick the students: by campus, class, section or C.C.');
        }
        for (const c of dto.campus_ids ?? []) this.scope.assertCampus(user, c);
        const rows = await this.prisma.students.findMany({
            where: {
                AND: [
                    { deleted_at: null, status: 'ENROLLED' },
                    has(dto.student_ids) ? { cc: { in: dto.student_ids } } : {},
                    has(dto.campus_ids) ? { campus_id: { in: dto.campus_ids } } : {},
                    has(dto.class_ids) ? { class_id: { in: dto.class_ids } } : {},
                    has(dto.section_ids) ? { section_id: { in: dto.section_ids } } : {},
                    this.scope.whereForStudents(user) as Prisma.studentsWhereInput,
                ],
            },
            select: STUDENT_SELECT,
            orderBy: [{ campus_id: 'asc' }, { class_id: 'asc' }, { full_name: 'asc' }],
            take: EC_BULK_CHARGE_MAX_STUDENTS + 1,
        });
        if (rows.length > EC_BULK_CHARGE_MAX_STUDENTS) {
            throw new BadRequestException(`More than ${EC_BULK_CHARGE_MAX_STUDENTS} students match. Narrow it down.`);
        }
        return rows;
    }

    // ─── One student ──────────────────────────────────────────────────────

    async listForStudent(user: IJwtStaffPayload, cc: number, academicYears: string[] = []) {
        const student = await this.loadVisibleStudent(user, cc);
        const years = [...new Set(academicYears.map(normalizeEcAcademicYear))];
        const charges = await this.prisma.ec_student_charges.findMany({
            where: { student_id: cc, ...(years.length ? { academic_year: { in: years } } : {}) },
            select: CHARGE_SELECT,
            orderBy: [{ academic_year: 'desc' }, { ec_fee_heads: { sort_order: 'asc' } }, { fee_head_id: 'asc' }, { period: 'asc' }],
        });
        return { student: studentView(student), charges: charges.map(chargeView) };
    }

    /** Active heads with the class amount this student would be charged in a year (null: no class amount). */
    async classAmountsForStudent(user: IJwtStaffPayload, cc: number, academicYear: string) {
        const student = await this.loadVisibleStudent(user, cc);
        const year = normalizeEcAcademicYear(academicYear);
        const heads = await this.prisma.ec_fee_heads.findMany({
            where: { is_active: true },
            select: { id: true, name: true, frequency: true, months: true, sort_order: true },
            orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
        });
        const lookup = await loadClassAmounts(this.prisma, year, heads.map((h) => h.id), student.class_id ? [student.class_id] : []);
        return heads.map((h) => ({
            fee_head_id: h.id,
            name: h.name,
            frequency: h.frequency,
            months: h.months,
            amount: lookup(student.campus_id, student.class_id, h.id),
        }));
    }

    /**
     * Save a student's grid for one academic year. A number sets the charge (a
     * new one is created for that head and month); null removes it. A charge
     * already on a voucher, paid or waived refuses any change, and the whole
     * save rolls back.
     */
    async save(user: IJwtStaffPayload, cc: number, dto: SaveEcStudentChargesDto) {
        const student = await this.loadVisibleStudent(user, cc);
        const year = normalizeEcAcademicYear(dto.academic_year);
        const seen = new Set<string>();
        for (const c of dto.cells) {
            const key = `${c.fee_head_id}|${c.target_month}`;
            if (seen.has(key)) throw new BadRequestException('The same head and month appears twice in one save');
            seen.add(key);
        }
        const headIds = [...new Set(dto.cells.map((c) => c.fee_head_id))];
        const heads = await this.prisma.ec_fee_heads.findMany({ where: { id: { in: headIds } }, select: { id: true, name: true, months: true, is_active: true } });
        if (heads.length !== headIds.length) throw new BadRequestException('A head in this save no longer exists');
        const headById = new Map(heads.map((h) => [h.id, h]));
        const classTerms = await getClassTermMap(this.prisma);
        const by = actorOf(user);

        const changes: { action: 'CREATED' | 'UPDATED' | 'DELETED'; note: string }[] = [];
        await this.prisma.$transaction(async (tx) => {
            const existing = await tx.ec_student_charges.findMany({
                where: { student_id: cc, academic_year: year, fee_head_id: { in: headIds } },
                select: { id: true, fee_head_id: true, target_month: true, amount: true, status: true, amount_paid: true, waived_amount: true, current_voucher_id: true },
            });
            const byKey = new Map(existing.map((e) => [`${e.fee_head_id}|${e.target_month}`, e]));

            for (const cell of dto.cells) {
                const head = headById.get(cell.fee_head_id)!;
                const label = `${head.name} ${ecPeriodLabel(ecPeriodOf(cell.target_month, year, student.class_id, classTerms))}`;
                const ex = byKey.get(`${cell.fee_head_id}|${cell.target_month}`);
                if (ex) {
                    if (cell.amount != null && Number(ex.amount) === cell.amount) continue;
                    const lock = chargeLockReason(ex);
                    if (lock) throw new ConflictException(`${label} is ${LOCK_TEXT[lock]}; change it through its voucher`);
                    const guard = { id: ex.id, status: 'NOT_ISSUED' as const, current_voucher_id: null, amount_paid: 0 };
                    if (cell.amount == null) {
                        const res = await tx.ec_student_charges.deleteMany({ where: guard });
                        if (res.count !== 1) throw new ConflictException(`${label} was just issued; reload and try again`);
                        changes.push({ action: 'DELETED', note: `${label}: removed (was ${Number(ex.amount)})` });
                    } else {
                        const res = await tx.ec_student_charges.updateMany({ where: guard, data: { amount: cell.amount } });
                        if (res.count !== 1) throw new ConflictException(`${label} was just issued; reload and try again`);
                        changes.push({ action: 'UPDATED', note: `${label}: ${Number(ex.amount)} → ${cell.amount}` });
                    }
                } else if (cell.amount != null) {
                    if (student.status !== 'ENROLLED' || student.deleted_at) {
                        throw new BadRequestException('Only enrolled students can be given new extracurricular charges');
                    }
                    if (!head.is_active) throw new BadRequestException(`${head.name} is inactive and can't be charged`);
                    if (!head.months.includes(cell.target_month)) throw new BadRequestException(`${head.name} isn't charged in month ${cell.target_month}`);
                    await tx.ec_student_charges.create({
                        data: {
                            student_id: cc,
                            fee_head_id: head.id,
                            academic_year: year,
                            target_month: cell.target_month,
                            period: ecPeriodOf(cell.target_month, year, student.class_id, classTerms),
                            amount: cell.amount,
                            source: cell.source ?? 'CUSTOM',
                            created_by: by,
                        },
                    });
                    changes.push({ action: 'CREATED', note: `${label}: ${cell.amount}` });
                }
            }
        });

        if (changes.length) {
            await this.auditLogs.logGroup(
                {
                    entity_type: 'EC_STUDENT_CHARGE',
                    entity_id: String(cc),
                    action: 'UPDATED',
                    section: 'finance',
                    student_id: cc,
                    note: `Extracurricular charges for ${year}: ${changes.length} change(s)`,
                    changed_by: by,
                },
                changes.map((c) => ({ entity_type: 'EC_STUDENT_CHARGE', entity_id: String(cc), action: c.action, section: 'finance', student_id: cc, note: c.note })),
            );
        }
        return {
            created: changes.filter((c) => c.action === 'CREATED').length,
            updated: changes.filter((c) => c.action === 'UPDATED').length,
            removed: changes.filter((c) => c.action === 'DELETED').length,
        };
    }

    // ─── Bulk assign ──────────────────────────────────────────────────────

    private async planAssign(user: IJwtStaffPayload, dto: EcBulkAssignDto) {
        const head = await this.prisma.ec_fee_heads.findUnique({ where: { id: dto.fee_head_id }, select: { id: true, name: true, frequency: true, months: true, is_active: true } });
        if (!head) throw new NotFoundException(`Extracurricular head #${dto.fee_head_id} not found`);
        if (!head.is_active) throw new BadRequestException(`${head.name} is inactive and can't be charged`);
        const year = normalizeEcAcademicYear(dto.academic_year);
        const months = dto.months?.length ? normalizeEcMonths(dto.months) : head.months;
        const outside = months.filter((m) => !head.months.includes(m));
        if (outside.length) throw new BadRequestException(`${head.name} isn't charged in month(s) ${outside.join(', ')}`);
        if (dto.amount_source === 'CUSTOM' && !(Number.isInteger(dto.amount) && (dto.amount ?? 0) >= 1)) {
            throw new BadRequestException('Give the amount in whole rupees');
        }

        const students = await this.targetStudents(user, dto);
        const ccs = students.map((s) => s.cc);
        const [lookup, existing, classTerms] = await Promise.all([
            loadClassAmounts(this.prisma, year, [head.id], [...new Set(students.map((s) => s.class_id).filter((c): c is number => c != null))]),
            ccs.length
                ? this.prisma.ec_student_charges.findMany({
                      where: { fee_head_id: head.id, academic_year: year, student_id: { in: ccs }, target_month: { in: months } },
                      select: { student_id: true, target_month: true },
                  })
                : Promise.resolve([] as { student_id: number; target_month: number }[]),
            getClassTermMap(this.prisma),
        ]);
        const charged = new Set(existing.map((e) => `${e.student_id}|${e.target_month}`));

        const rows = students.map((s) => {
            const base = {
                cc: s.cc,
                full_name: s.full_name,
                gr_number: s.gr_number,
                campus_name: s.campuses?.campus_name ?? null,
                class_name: s.classes?.description ?? null,
                section_name: s.sections?.description ?? null,
            };
            const amount = dto.amount_source === 'CUSTOM' ? dto.amount! : lookup(s.campus_id, s.class_id, head.id);
            if (amount == null) {
                return { ...base, student: s, amount: null, months_to_create: [] as number[], skip_reason: s.class_id ? ('NO_CLASS_AMOUNT' as const) : ('NO_CLASS' as const) };
            }
            const missing = months.filter((m) => !charged.has(`${s.cc}|${m}`));
            if (!missing.length) return { ...base, student: s, amount, months_to_create: [] as number[], skip_reason: 'ALREADY_CHARGED' as const };
            return { ...base, student: s, amount, months_to_create: missing, skip_reason: null };
        });
        return { head, year, months, rows, classTerms, requested: dto.student_ids?.length ?? null };
    }

    private assignSummary(plan: Awaited<ReturnType<EcChargesService['planAssign']>>) {
        const doing = plan.rows.filter((r) => r.skip_reason == null);
        const count = (reason: string) => plan.rows.filter((r) => r.skip_reason === reason).length;
        return {
            head: { id: plan.head.id, name: plan.head.name, frequency: plan.head.frequency },
            academic_year: plan.year,
            months: plan.months,
            students_matched: plan.rows.length,
            students_requested: plan.requested,
            students_to_charge: doing.length,
            charges_to_create: doing.reduce((n, r) => n + r.months_to_create.length, 0),
            total_amount: doing.reduce((n, r) => n + r.months_to_create.length * (r.amount ?? 0), 0),
            skipped: { already_charged: count('ALREADY_CHARGED'), no_class_amount: count('NO_CLASS_AMOUNT'), no_class: count('NO_CLASS') },
        };
    }

    async bulkAssignPreview(user: IJwtStaffPayload, dto: EcBulkAssignDto) {
        const plan = await this.planAssign(user, dto);
        return {
            ...this.assignSummary(plan),
            rows: plan.rows.slice(0, PREVIEW_ROWS).map(({ student: _s, ...r }) => r),
            rows_truncated: plan.rows.length > PREVIEW_ROWS,
        };
    }

    async bulkAssign(user: IJwtStaffPayload, dto: EcBulkAssignDto) {
        const plan = await this.planAssign(user, dto);
        const by = actorOf(user);
        const data: Prisma.ec_student_chargesCreateManyInput[] = [];
        for (const r of plan.rows) {
            for (const m of r.months_to_create) {
                data.push({
                    student_id: r.cc,
                    fee_head_id: plan.head.id,
                    academic_year: plan.year,
                    target_month: m,
                    period: ecPeriodOf(m, plan.year, r.student.class_id, plan.classTerms),
                    amount: r.amount!,
                    source: dto.amount_source,
                    created_by: by,
                });
            }
        }
        let created = 0;
        // The unique (student, head, year, month) makes a re-run or a race harmless.
        for (let i = 0; i < data.length; i += 2000) {
            created += (await this.prisma.ec_student_charges.createMany({ data: data.slice(i, i + 2000), skipDuplicates: true })).count;
        }
        const summary = this.assignSummary(plan);
        if (created > 0) {
            await this.auditLogs.logGroup(
                {
                    entity_type: 'EC_STUDENT_CHARGE',
                    entity_id: `bulk-assign:${plan.head.id}:${plan.year}`,
                    action: 'CREATED',
                    section: 'finance',
                    new_value: JSON.stringify({ head: plan.head.name, year: plan.year, months: plan.months, source: dto.amount_source, created, students: summary.students_to_charge }),
                    changed_by: by,
                },
                plan.rows
                    .filter((r) => r.months_to_create.length)
                    .map((r) => ({
                        entity_type: 'EC_STUDENT_CHARGE',
                        entity_id: String(r.cc),
                        action: 'CREATED',
                        section: 'finance',
                        student_id: r.cc,
                        note: `${plan.head.name} ${plan.year}: months ${r.months_to_create.join(', ')} at ${r.amount}`,
                    })),
            );
        }
        return { ...summary, created };
    }

    // ─── Bulk remove ──────────────────────────────────────────────────────

    private async planRemove(user: IJwtStaffPayload, dto: EcBulkRemoveDto) {
        const head = await this.prisma.ec_fee_heads.findUnique({ where: { id: dto.fee_head_id }, select: { id: true, name: true, frequency: true } });
        if (!head) throw new NotFoundException(`Extracurricular head #${dto.fee_head_id} not found`);
        const year = normalizeEcAcademicYear(dto.academic_year);
        const months = dto.months?.length ? normalizeEcMonths(dto.months) : null;
        const students = await this.targetStudents(user, dto);
        const byCc = new Map(students.map((s) => [s.cc, s]));
        const charges = students.length
            ? await this.prisma.ec_student_charges.findMany({
                  where: { fee_head_id: head.id, academic_year: year, student_id: { in: students.map((s) => s.cc) }, ...(months ? { target_month: { in: months } } : {}) },
                  select: {
                      id: true,
                      student_id: true,
                      target_month: true,
                      period: true,
                      amount: true,
                      status: true,
                      amount_paid: true,
                      waived_amount: true,
                      current_voucher_id: true,
                      current_voucher: { select: { voucher_number: true } },
                  },
                  orderBy: [{ student_id: 'asc' }, { period: 'asc' }],
              })
            : [];
        const removable = charges.filter((c) => !chargeLockReason(c));
        const locked = charges.filter((c) => chargeLockReason(c));
        return { head, year, months, students, byCc, removable, locked };
    }

    private removeSummary(plan: Awaited<ReturnType<EcChargesService['planRemove']>>) {
        const reasons = { ON_VOUCHER: 0, PAID: 0, WAIVED: 0 } as Record<EcChargeLockReason, number>;
        for (const c of plan.locked) reasons[chargeLockReason(c)!]++;
        return {
            head: plan.head,
            academic_year: plan.year,
            months: plan.months,
            students_matched: plan.students.length,
            charges_to_remove: plan.removable.length,
            amount_to_remove: plan.removable.reduce((n, c) => n + Number(c.amount), 0),
            locked: plan.locked.length,
            locked_by_reason: reasons,
        };
    }

    async bulkRemovePreview(user: IJwtStaffPayload, dto: EcBulkRemoveDto) {
        const plan = await this.planRemove(user, dto);
        const perStudent = new Map<number, { removable: string[]; locked: { period: string; reason: EcChargeLockReason; voucher_number: string | null }[] }>();
        for (const c of [...plan.removable, ...plan.locked]) {
            const entry = perStudent.get(c.student_id) ?? { removable: [], locked: [] };
            const lock = chargeLockReason(c);
            if (lock) entry.locked.push({ period: ecPeriodLabel(c.period), reason: lock, voucher_number: c.current_voucher?.voucher_number ?? null });
            else entry.removable.push(ecPeriodLabel(c.period));
            perStudent.set(c.student_id, entry);
        }
        const rows = [...perStudent.entries()].map(([cc, e]) => {
            const s = plan.byCc.get(cc)!;
            return { cc, full_name: s.full_name, gr_number: s.gr_number, class_name: s.classes?.description ?? null, section_name: s.sections?.description ?? null, removable: e.removable, locked: e.locked };
        });
        return { ...this.removeSummary(plan), rows: rows.slice(0, PREVIEW_ROWS), rows_truncated: rows.length > PREVIEW_ROWS };
    }

    async bulkRemove(user: IJwtStaffPayload, dto: EcBulkRemoveDto) {
        const plan = await this.planRemove(user, dto);
        const ids = plan.removable.map((c) => c.id);
        // Guarded again: a charge issued since the plan stays.
        const removed = ids.length
            ? (await this.prisma.ec_student_charges.deleteMany({ where: { id: { in: ids }, status: 'NOT_ISSUED', current_voucher_id: null, amount_paid: 0 } })).count
            : 0;
        const by = actorOf(user);
        if (removed > 0) {
            const perStudent = new Map<number, string[]>();
            for (const c of plan.removable) perStudent.set(c.student_id, [...(perStudent.get(c.student_id) ?? []), ecPeriodLabel(c.period)]);
            await this.auditLogs.logGroup(
                {
                    entity_type: 'EC_STUDENT_CHARGE',
                    entity_id: `bulk-remove:${plan.head.id}:${plan.year}`,
                    action: 'DELETED',
                    section: 'finance',
                    old_value: JSON.stringify({ head: plan.head.name, year: plan.year, months: plan.months, removed }),
                    changed_by: by,
                },
                [...perStudent.entries()].map(([cc, periods]) => ({
                    entity_type: 'EC_STUDENT_CHARGE',
                    entity_id: String(cc),
                    action: 'DELETED',
                    section: 'finance',
                    student_id: cc,
                    note: `${plan.head.name}: ${periods.join(', ')} removed`,
                })),
            );
        }
        return { ...this.removeSummary(plan), removed };
    }
}
