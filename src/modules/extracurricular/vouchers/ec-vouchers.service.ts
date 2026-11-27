import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ScopeService } from '../../../common/scope/scope.service';
import { StorageService } from '../../../common/storage/storage.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { findStudentSearchHits } from '../../students/student-search-match';
import { EcChargesService } from '../charges/ec-charges.service';
import { EC_ALLOW_REISSUE_BEFORE_EXPIRY, EC_DEFAULT_VALIDITY_DAYS, EC_SEARCH_LIMIT } from '../ec.constants';
import { actorNameOf, actorOf, normalizeEcAcademicYear } from '../ec-common.util';
import { addDays, dateKey, ecPeriodLabel, parseDateKey, todayPktDate, todayPktKey } from '../ec-dates.util';
import { createVoucherInTx, resolveEcBank } from '../ec-issue';
import { remainingOf } from '../ec-money.util';
import { lockEcVoucher, recomputeVoucherInTx } from '../ec-recompute';
import { ecStateWhere, ecVoucherIsLive, ecVoucherState, type EcVoucherState } from '../ec-voucher-state';
import {
    CreateEcVoucherDto,
    EcVoucherFilterDto,
    EcVoucherListQueryDto,
    EcVoucherSearchQueryDto,
    ReissueEcVoucherDto,
    WaiveEcVoucherDto,
} from './dto/ec-vouchers.dto';

const LIST_SELECT = {
    id: true,
    voucher_number: true,
    student_id: true,
    campus_id: true,
    class_id: true,
    section_id: true,
    academic_year: true,
    issue_date: true,
    expiry_date: true,
    status: true,
    total_amount: true,
    amount_paid: true,
    amount_waived: true,
    bulk_run_id: true,
    generated_by_name: true,
    created_at: true,
    waived_at: true,
    waived_by: true,
    waive_reason: true,
    students: { select: { full_name: true, gr_number: true } },
    campuses: { select: { campus_name: true } },
    classes: { select: { description: true } },
    sections: { select: { description: true } },
    reissued_to: { select: { id: true, voucher_number: true } },
    reissued_from: { select: { id: true, voucher_number: true } },
    _count: { select: { ec_deposits: true, ec_voucher_lines: true } },
} as const;
type ListRow = Prisma.ec_vouchersGetPayload<{ select: typeof LIST_SELECT }>;

const DETAIL_SELECT = {
    ...LIST_SELECT,
    bank_snapshot: true,
    pdf_url: true,
    paid_pdf_url: true,
    ec_voucher_lines: {
        select: {
            id: true,
            charge_id: true,
            description: true,
            amount: true,
            amount_paid: true,
            waived_amount: true,
            sort_order: true,
            ec_student_charges: { select: { fee_head_id: true, target_month: true, period: true, ec_fee_heads: { select: { name: true } } } },
        },
        orderBy: { sort_order: 'asc' as const },
    },
    ec_deposits: {
        select: {
            id: true,
            amount: true,
            deposit_date: true,
            payment_method: true,
            reference_number: true,
            bank_name: true,
            remarks: true,
            recorded_by_name: true,
            created_at: true,
            ec_deposit_allocations: { select: { line_id: true, amount: true } },
        },
        orderBy: { id: 'desc' as const },
    },
} as const;
type DetailRow = Prisma.ec_vouchersGetPayload<{ select: typeof DETAIL_SELECT }>;

const ISSUABLE_CHARGE_SELECT = {
    id: true,
    fee_head_id: true,
    academic_year: true,
    target_month: true,
    period: true,
    amount: true,
    status: true,
    current_voucher_id: true,
    ec_fee_heads: { select: { name: true, sort_order: true } },
} as const;

function listView(v: ListRow, today: string) {
    const total = Number(v.total_amount);
    const paid = Number(v.amount_paid);
    const waived = Number(v.amount_waived);
    const state = ecVoucherState(v, today);
    return {
        id: v.id,
        voucher_number: v.voucher_number,
        state,
        status: v.status,
        student: { cc: v.student_id, full_name: v.students.full_name, gr_number: v.students.gr_number },
        campus_id: v.campus_id,
        campus_name: v.campuses.campus_name,
        class_id: v.class_id,
        class_name: v.classes.description,
        section_id: v.section_id,
        section_name: v.sections?.description ?? null,
        academic_year: v.academic_year,
        issue_date: dateKey(v.issue_date),
        expiry_date: dateKey(v.expiry_date),
        total_amount: total,
        amount_paid: paid,
        amount_waived: waived,
        balance: Math.max(total - paid - waived, 0),
        deposits_count: v._count.ec_deposits,
        lines_count: v._count.ec_voucher_lines,
        reissued_to: v.reissued_to,
        reissued_from: v.reissued_from,
        bulk_run_id: v.bulk_run_id,
        waived_at: v.waived_at,
        waived_by: v.waived_by,
        waive_reason: v.waive_reason,
        generated_by_name: v.generated_by_name,
        created_at: v.created_at,
    };
}

function detailView(v: DetailRow, today: string) {
    const latestDepositId = v.ec_deposits[0]?.id ?? null;
    return {
        ...listView(v, today),
        bank: v.bank_snapshot,
        has_pdf: !!(v.pdf_url || v.paid_pdf_url),
        lines: v.ec_voucher_lines.map((l) => {
            const x = { amount: Number(l.amount), amount_paid: Number(l.amount_paid), waived_amount: Number(l.waived_amount) };
            return {
                id: l.id,
                charge_id: l.charge_id,
                fee_head_id: l.ec_student_charges.fee_head_id,
                fee_head_name: l.ec_student_charges.ec_fee_heads.name,
                period: dateKey(l.ec_student_charges.period),
                period_label: ecPeriodLabel(l.ec_student_charges.period),
                description: l.description,
                ...x,
                remaining: remainingOf(x),
            };
        }),
        deposits: v.ec_deposits.map((d) => ({
            id: d.id,
            amount: Number(d.amount),
            deposit_date: dateKey(d.deposit_date),
            payment_method: d.payment_method,
            reference_number: d.reference_number,
            bank_name: d.bank_name,
            remarks: d.remarks,
            recorded_by_name: d.recorded_by_name,
            created_at: d.created_at,
            is_latest: d.id === latestDepositId,
            allocations: d.ec_deposit_allocations.map((a) => ({ line_id: a.line_id, amount: Number(a.amount) })),
        })),
    };
}

/**
 * TAFSD-605: extracurricular vouchers. Issuing one never touches another
 * voucher (no arrears pulled in, nothing voided); older open vouchers are
 * shown beside it and in payment history only. Every issue goes through
 * createVoucherInTx (ec-issue.ts).
 */
@Injectable()
export class EcVouchersService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly scope: ScopeService,
        private readonly auditLogs: AuditLogsService,
        private readonly charges: EcChargesService,
        private readonly storage: StorageService,
    ) {}

    /** The caller's scope on the voucher's placement (copied at issue). Same shape as the academic vouchers. */
    private scoped(user: IJwtStaffPayload): Prisma.ec_vouchersWhereInput {
        return this.scope.whereForVouchers(user) as Prisma.ec_vouchersWhereInput;
    }

    /** A voucher number (with or without "EC") or any way of naming a student. */
    private async textWhere(q: string | undefined): Promise<Prisma.ec_vouchersWhereInput | undefined> {
        const text = (q ?? '').trim();
        if (!text) return undefined;
        const or: Prisma.ec_vouchersWhereInput[] = [];
        const digits = text.replace(/^ec/i, '').replace(/\s+/g, '');
        if (/^\d{3,}$/.test(digits)) or.push({ voucher_number: { contains: digits } });
        if (/^ec\d*$/i.test(text.replace(/\s+/g, ''))) or.push({ voucher_number: { startsWith: text.replace(/\s+/g, '').toUpperCase() } });
        const hits = await findStudentSearchHits(this.prisma, text, 500);
        if (hits.length) or.push({ student_id: { in: hits.map((h) => h.cc) } });
        return or.length ? { OR: or } : { id: -1 };
    }

    private async filterWhere(user: IJwtStaffPayload, f: EcVoucherFilterDto): Promise<Prisma.ec_vouchersWhereInput> {
        for (const c of f.campus_ids ?? []) this.scope.assertCampus(user, c);
        const and: Prisma.ec_vouchersWhereInput[] = [this.scoped(user)];
        if (f.campus_ids?.length) and.push({ campus_id: { in: f.campus_ids } });
        if (f.class_ids?.length) and.push({ class_id: { in: f.class_ids } });
        if (f.section_ids?.length) and.push({ section_id: { in: f.section_ids } });
        if (f.academic_years?.length) and.push({ academic_year: { in: f.academic_years.map(normalizeEcAcademicYear) } });
        if (f.fee_head_ids?.length) and.push({ ec_voucher_lines: { some: { ec_student_charges: { fee_head_id: { in: f.fee_head_ids } } } } });
        const states = ecStateWhere(f.states ?? [], todayPktDate());
        if (states) and.push(states);
        if (f.issue_from || f.issue_to) {
            and.push({ issue_date: { ...(f.issue_from ? { gte: parseDateKey(f.issue_from, 'Issued from') } : {}), ...(f.issue_to ? { lte: parseDateKey(f.issue_to, 'Issued to') } : {}) } });
        }
        if (f.expiry_from || f.expiry_to) {
            and.push({ expiry_date: { ...(f.expiry_from ? { gte: parseDateKey(f.expiry_from, 'Valid till from') } : {}), ...(f.expiry_to ? { lte: parseDateKey(f.expiry_to, 'Valid till to') } : {}) } });
        }
        if (f.student_id) and.push({ student_id: f.student_id });
        if (f.bulk_run_id) and.push({ bulk_run_id: f.bulk_run_id });
        const text = await this.textWhere(f.q);
        if (text) and.push(text);
        return { AND: and };
    }

    // ─── Reads ─────────────────────────────────────────────────────────────

    async list(user: IJwtStaffPayload, query: EcVoucherListQueryDto) {
        const page = query.page ?? 1;
        const limit = query.limit ?? 50;
        const where = await this.filterWhere(user, query);
        const [total, rows, sums] = await Promise.all([
            this.prisma.ec_vouchers.count({ where }),
            this.prisma.ec_vouchers.findMany({ where, select: LIST_SELECT, orderBy: [{ issue_date: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
            this.prisma.ec_vouchers.aggregate({ where, _sum: { total_amount: true, amount_paid: true, amount_waived: true } }),
        ]);
        const today = todayPktKey();
        const billed = Number(sums._sum.total_amount ?? 0);
        const paid = Number(sums._sum.amount_paid ?? 0);
        const waived = Number(sums._sum.amount_waived ?? 0);
        return {
            items: rows.map((r) => listView(r, today)),
            meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
            summary: { count: total, total_amount: billed, amount_paid: paid, amount_waived: waived, balance: Math.max(billed - paid - waived, 0) },
        };
    }

    /** Rule 2 shape: empty text finds nothing; a small projection; at most 20; scope merged. */
    async searchSimple(user: IJwtStaffPayload, query: EcVoucherSearchQueryDto) {
        if (!(query.q ?? '').trim()) return [];
        const where = await this.filterWhere(user, { q: query.q, campus_ids: query.campus_ids, class_ids: query.class_ids, section_ids: query.section_ids });
        const rows = await this.prisma.ec_vouchers.findMany({
            where,
            select: {
                id: true,
                voucher_number: true,
                student_id: true,
                status: true,
                expiry_date: true,
                total_amount: true,
                amount_paid: true,
                amount_waived: true,
                students: { select: { full_name: true, gr_number: true } },
                classes: { select: { description: true } },
                reissued_to: { select: { id: true } },
            },
            orderBy: [{ issue_date: 'desc' }, { id: 'desc' }],
            take: EC_SEARCH_LIMIT,
        });
        const today = todayPktKey();
        return rows.map((r) => ({
            id: r.id,
            voucher_number: r.voucher_number,
            student_id: r.student_id,
            full_name: r.students.full_name,
            gr_number: r.students.gr_number,
            class_name: r.classes.description,
            state: ecVoucherState(r, today),
            expiry_date: dateKey(r.expiry_date),
            balance: Math.max(Number(r.total_amount) - Number(r.amount_paid) - Number(r.amount_waived), 0),
        }));
    }

    async detail(user: IJwtStaffPayload, id: number) {
        const v = await this.prisma.ec_vouchers.findFirst({ where: { AND: [{ id }, this.scoped(user)] }, select: DETAIL_SELECT });
        if (!v) throw new NotFoundException(`Extracurricular voucher #${id} not found`);
        return detailView(v, todayPktKey());
    }

    /** Throws 404 unless the caller may see the voucher. */
    async assertVisible(user: IJwtStaffPayload, id: number): Promise<void> {
        const n = await this.prisma.ec_vouchers.count({ where: { AND: [{ id }, this.scoped(user)] } });
        if (!n) throw new NotFoundException(`Extracurricular voucher #${id} not found`);
    }

    /**
     * Everything one student has: vouchers (with lines and payments), charges not
     * yet on a voucher, and the totals. A visible student's whole EC history is
     * shown, wherever they were placed when each voucher was issued.
     */
    async forStudent(user: IJwtStaffPayload, cc: number) {
        const student = await this.charges.loadVisibleStudent(user, cc);
        const [vouchers, unissued] = await Promise.all([
            this.prisma.ec_vouchers.findMany({ where: { student_id: cc }, select: DETAIL_SELECT, orderBy: [{ issue_date: 'desc' }, { id: 'desc' }] }),
            this.prisma.ec_student_charges.findMany({
                where: { student_id: cc, current_voucher_id: null, status: 'NOT_ISSUED' },
                select: ISSUABLE_CHARGE_SELECT,
                orderBy: [{ academic_year: 'desc' }, { period: 'asc' }],
            }),
        ]);
        const today = todayPktKey();
        const views = vouchers.map((v) => detailView(v, today));
        const sumWhere = (pred: (s: EcVoucherState) => boolean) => views.filter((v) => pred(v.state)).reduce((n, v) => n + v.balance, 0);
        return {
            student: {
                cc: student.cc,
                full_name: student.full_name,
                gr_number: student.gr_number,
                status: student.status,
                campus_name: student.campuses?.campus_name ?? null,
                class_name: student.classes?.description ?? null,
                section_name: student.sections?.description ?? null,
            },
            vouchers: views,
            unissued_charges: unissued.map((c) => ({
                id: c.id,
                fee_head_id: c.fee_head_id,
                fee_head_name: c.ec_fee_heads.name,
                academic_year: c.academic_year,
                target_month: c.target_month,
                period: dateKey(c.period),
                period_label: ecPeriodLabel(c.period),
                amount: Number(c.amount),
            })),
            stats: {
                // A reissue re-bills only the old voucher's remainder, so count that remainder once.
                billed: views.reduce((n, v) => n + v.total_amount, 0) - views.filter((v) => v.state === 'REISSUED').reduce((n, v) => n + v.balance, 0),
                received: views.reduce((n, v) => n + v.amount_paid, 0),
                waived: views.reduce((n, v) => n + v.amount_waived, 0),
                open_balance: sumWhere((s) => s === 'UNPAID' || s === 'PARTIALLY_PAID'),
                lapsed_balance: sumWhere((s) => s === 'EXPIRED'),
                unissued: unissued.reduce((n, c) => n + Number(c.amount), 0),
            },
        };
    }

    /** What can go on a new voucher for this student, and the open vouchers it will NOT include. */
    async issuable(user: IJwtStaffPayload, cc: number) {
        const student = await this.charges.loadVisibleStudent(user, cc);
        const [charges, open] = await Promise.all([
            this.prisma.ec_student_charges.findMany({
                where: { student_id: cc, current_voucher_id: null, status: 'NOT_ISSUED' },
                select: ISSUABLE_CHARGE_SELECT,
                orderBy: [{ academic_year: 'desc' }, { ec_fee_heads: { sort_order: 'asc' } }, { period: 'asc' }],
            }),
            this.prisma.ec_vouchers.findMany({
                where: { student_id: cc, status: { in: ['UNPAID', 'PARTIALLY_PAID'] }, reissued_to: { is: null } },
                select: LIST_SELECT,
                orderBy: [{ expiry_date: 'asc' }, { id: 'asc' }],
            }),
        ]);
        const today = todayPktKey();
        return {
            student: {
                cc: student.cc,
                full_name: student.full_name,
                gr_number: student.gr_number,
                status: student.status,
                campus_id: student.campus_id,
                campus_name: student.campuses?.campus_name ?? null,
                class_id: student.class_id,
                class_name: student.classes?.description ?? null,
                section_name: student.sections?.description ?? null,
            },
            charges: charges.map((c) => ({
                id: c.id,
                fee_head_id: c.fee_head_id,
                fee_head_name: c.ec_fee_heads.name,
                academic_year: c.academic_year,
                target_month: c.target_month,
                period: dateKey(c.period),
                period_label: ecPeriodLabel(c.period),
                amount: Number(c.amount),
            })),
            open_vouchers: open.map((v) => listView(v, today)),
            default_validity_days: EC_DEFAULT_VALIDITY_DAYS,
        };
    }

    // ─── Issue one voucher ─────────────────────────────────────────────────

    async create(user: IJwtStaffPayload, dto: CreateEcVoucherDto) {
        const student = await this.charges.loadVisibleStudent(user, dto.student_id);
        if (student.status !== 'ENROLLED' || student.deleted_at) throw new BadRequestException('Only enrolled students can be issued an extracurricular voucher');
        if (!student.campus_id || !student.class_id) throw new BadRequestException('Place the student in a campus and class first');

        const issueDate = parseDateKey(dto.issue_date, 'Issue date');
        const expiryDate = dto.expiry_date ? parseDateKey(dto.expiry_date, 'Valid-till date') : addDays(issueDate, EC_DEFAULT_VALIDITY_DAYS);
        if (expiryDate < issueDate) throw new BadRequestException('The valid-till date is before the issue date');
        if (dateKey(expiryDate) < todayPktKey()) throw new BadRequestException('The valid-till date has already passed');

        const ids = [...new Set(dto.charge_ids)];
        const charges = await this.prisma.ec_student_charges.findMany({ where: { id: { in: ids }, student_id: student.cc }, select: ISSUABLE_CHARGE_SELECT });
        if (charges.length !== ids.length) throw new BadRequestException("Some of those charges aren't this student's");
        const taken = charges.find((c) => c.status !== 'NOT_ISSUED' || c.current_voucher_id != null);
        if (taken) throw new ConflictException(`${taken.ec_fee_heads.name} (${ecPeriodLabel(taken.period)}) is already on a voucher`);
        const years = [...new Set(charges.map((c) => c.academic_year))];
        if (years.length > 1) throw new BadRequestException('Put one academic year on a voucher at a time');

        const bank = await resolveEcBank(this.prisma, dto.bank_account_id);
        const ordered = [...charges].sort(
            (a, b) => a.ec_fee_heads.sort_order - b.ec_fee_heads.sort_order || a.period.getTime() - b.period.getTime() || a.id - b.id,
        );
        const result = await this.prisma.$transaction(
            (tx) =>
                createVoucherInTx(tx, {
                    student: { cc: student.cc, campus_id: student.campus_id!, class_id: student.class_id!, section_id: student.section_id },
                    academicYear: years[0],
                    issueDate,
                    expiryDate,
                    bank,
                    lines: ordered.map((c, i) => ({ charge_id: c.id, description: `${c.ec_fee_heads.name} (${ecPeriodLabel(c.period)})`, amount: Number(c.amount), sort_order: i })),
                    expectCurrentVoucherId: null,
                    createdBy: actorOf(user),
                    generatedByName: actorNameOf(user),
                }),
            { timeout: 20_000 },
        );

        await this.auditLogs.log({
            entity_type: 'EC_VOUCHER',
            entity_id: String(result.id),
            action: 'CREATED',
            section: 'finance',
            student_id: student.cc,
            new_value: JSON.stringify({
                voucher_number: result.voucher_number,
                lines: ordered.length,
                total: ordered.reduce((n, c) => n + Number(c.amount), 0),
                issue_date: dateKey(issueDate),
                expiry_date: dateKey(expiryDate),
            }),
            changed_by: actorOf(user),
        });
        return this.detail(user, result.id);
    }

    // ─── Reissue an expired voucher ───────────────────────────────────────

    /**
     * An expired voucher can't take payment, so its unpaid part is put on a
     * fresh voucher with new dates. The old voucher stays as history (shown
     * REISSUED, out of the lapsed totals); its charges move to the new one by
     * compare-and-set. reissued_from_voucher_id is unique, so a voucher is
     * reissued at most once even if two people click at the same time.
     */
    async reissue(user: IJwtStaffPayload, id: number, dto: ReissueEcVoucherDto) {
        await this.assertVisible(user, id);
        const issueDate = parseDateKey(dto.issue_date, 'Issue date');
        const expiryDate = dto.expiry_date ? parseDateKey(dto.expiry_date, 'Valid-till date') : addDays(issueDate, EC_DEFAULT_VALIDITY_DAYS);
        if (expiryDate < issueDate) throw new BadRequestException('The valid-till date is before the issue date');
        if (dateKey(expiryDate) < todayPktKey()) throw new BadRequestException('The valid-till date has already passed');

        const old = await this.prisma.ec_vouchers.findUniqueOrThrow({ where: { id }, select: { student_id: true, bank_account_id: true } });
        const student = await this.prisma.students.findUnique({
            where: { cc: old.student_id },
            select: { cc: true, status: true, deleted_at: true, campus_id: true, class_id: true, section_id: true },
        });
        if (!student || student.status !== 'ENROLLED' || student.deleted_at) throw new BadRequestException('Only an enrolled student can be reissued a voucher');
        if (!student.campus_id || !student.class_id) throw new BadRequestException('Place the student in a campus and class first');
        let bank;
        try {
            bank = await resolveEcBank(this.prisma, dto.bank_account_id ?? old.bank_account_id);
        } catch {
            if (dto.bank_account_id) throw new BadRequestException(`Bank account #${dto.bank_account_id} can't be used`);
            bank = await resolveEcBank(this.prisma, null);
        }

        const result = await this.prisma.$transaction(
            async (tx) => {
                await lockEcVoucher(tx, id);
                const v = await tx.ec_vouchers.findUniqueOrThrow({
                    where: { id },
                    select: {
                        id: true,
                        voucher_number: true,
                        status: true,
                        expiry_date: true,
                        academic_year: true,
                        reissued_to: { select: { id: true } },
                        ec_voucher_lines: {
                            select: {
                                charge_id: true,
                                description: true,
                                sort_order: true,
                                ec_student_charges: { select: { amount: true, amount_paid: true, waived_amount: true } },
                            },
                            orderBy: { sort_order: 'asc' },
                        },
                    },
                });
                const state = ecVoucherState(v, todayPktKey());
                const allowed = state === 'EXPIRED' || (EC_ALLOW_REISSUE_BEFORE_EXPIRY && ecVoucherIsLive(state));
                if (!allowed) throw new ConflictException(`Only an expired voucher can be reissued; ${v.voucher_number} is ${state.toLowerCase().replace('_', ' ')}`);

                const lines = v.ec_voucher_lines
                    .map((l) => ({
                        charge_id: l.charge_id,
                        description: l.description,
                        sort_order: l.sort_order,
                        amount: remainingOf({
                            amount: Number(l.ec_student_charges.amount),
                            amount_paid: Number(l.ec_student_charges.amount_paid),
                            waived_amount: Number(l.ec_student_charges.waived_amount),
                        }),
                    }))
                    .filter((l) => l.amount > 0);
                if (!lines.length) throw new ConflictException(`${v.voucher_number} has nothing left to collect`);

                const created = await createVoucherInTx(tx, {
                    student: { cc: student.cc, campus_id: student.campus_id!, class_id: student.class_id!, section_id: student.section_id },
                    academicYear: v.academic_year,
                    issueDate,
                    expiryDate,
                    bank,
                    lines,
                    expectCurrentVoucherId: v.id,
                    reissuedFromVoucherId: v.id,
                    createdBy: actorOf(user),
                    generatedByName: actorNameOf(user),
                });
                await recomputeVoucherInTx(tx, v.id);
                return { ...created, old_number: v.voucher_number, total: lines.reduce((n, l) => n + l.amount, 0) };
            },
            { timeout: 20_000 },
        );

        await this.auditLogs.log({
            entity_type: 'EC_VOUCHER',
            entity_id: String(result.id),
            action: 'CREATED',
            section: 'finance',
            student_id: student.cc,
            new_value: JSON.stringify({ voucher_number: result.voucher_number, reissued_from: result.old_number, total: result.total, expiry_date: dateKey(expiryDate) }),
            note: `Reissued ${result.old_number} as ${result.voucher_number}`,
            changed_by: actorOf(user),
        });
        return this.detail(user, result.id);
    }

    // ─── Waive / unwaive ──────────────────────────────────────────────────

    /**
     * Write off everything still owed on a voucher, with a reason. Expired
     * vouchers can be waived (that is how a lapsed amount is cleared for good);
     * a reissued one can't (waive the new voucher instead). What was already
     * paid stays paid; the voucher shows WAIVED.
     */
    async waive(user: IJwtStaffPayload, id: number, dto: WaiveEcVoucherDto) {
        await this.assertVisible(user, id);
        const reason = dto.reason.trim();
        if (reason.length < 3) throw new BadRequestException('Give a reason for the waiver');
        const by = actorOf(user);
        const outcome = await this.prisma.$transaction(async (tx) => {
            await lockEcVoucher(tx, id);
            const v = await tx.ec_vouchers.findUniqueOrThrow({
                where: { id },
                select: {
                    voucher_number: true,
                    student_id: true,
                    status: true,
                    reissued_to: { select: { voucher_number: true } },
                    ec_voucher_lines: { select: { id: true, amount: true, amount_paid: true, waived_amount: true } },
                },
            });
            if (v.status === 'WAIVED') throw new ConflictException(`${v.voucher_number} is already waived`);
            if (v.status === 'PAID') throw new ConflictException(`${v.voucher_number} is paid; nothing is left to waive`);
            if (v.reissued_to) throw new ConflictException(`${v.voucher_number} was reissued as ${v.reissued_to.voucher_number}; waive that one instead`);
            let written = 0;
            for (const l of v.ec_voucher_lines) {
                const rest = Number(l.amount) - Number(l.amount_paid);
                if (rest > 0) {
                    await tx.ec_voucher_lines.update({ where: { id: l.id }, data: { waived_amount: rest } });
                    written += rest - Number(l.waived_amount);
                }
            }
            await tx.ec_vouchers.update({ where: { id }, data: { waived_at: new Date(), waived_by: by, waive_reason: reason } });
            await recomputeVoucherInTx(tx, id);
            return { voucher_number: v.voucher_number, student_id: v.student_id, written };
        });
        await this.auditLogs.log({
            entity_type: 'EC_VOUCHER',
            entity_id: String(id),
            action: 'UPDATED',
            section: 'finance',
            field: 'status',
            new_value: 'WAIVED',
            student_id: outcome.student_id,
            note: `Waived Rs ${outcome.written} on ${outcome.voucher_number}: ${reason}`,
            changed_by: by,
        });
        return this.detail(user, id);
    }

    async unwaive(user: IJwtStaffPayload, id: number) {
        await this.assertVisible(user, id);
        const outcome = await this.prisma.$transaction(async (tx) => {
            await lockEcVoucher(tx, id);
            const v = await tx.ec_vouchers.findUniqueOrThrow({ where: { id }, select: { voucher_number: true, student_id: true, status: true, waive_reason: true } });
            if (v.status !== 'WAIVED') throw new ConflictException(`${v.voucher_number} is not waived`);
            await tx.ec_voucher_lines.updateMany({ where: { voucher_id: id }, data: { waived_amount: 0 } });
            await tx.ec_vouchers.update({ where: { id }, data: { waived_at: null, waived_by: null, waive_reason: null } });
            const r = await recomputeVoucherInTx(tx, id);
            return { ...v, newStatus: r.status };
        });
        await this.auditLogs.log({
            entity_type: 'EC_VOUCHER',
            entity_id: String(id),
            action: 'UPDATED',
            section: 'finance',
            field: 'status',
            old_value: 'WAIVED',
            new_value: outcome.newStatus,
            student_id: outcome.student_id,
            note: `Waiver undone on ${outcome.voucher_number} (was: ${outcome.waive_reason ?? '-'})`,
            changed_by: actorOf(user),
        });
        return this.detail(user, id);
    }

    // ─── Delete (the way to fix a mistake; there is no VOID) ──────────────

    async remove(user: IJwtStaffPayload, id: number) {
        const v = await this.prisma.ec_vouchers.findFirst({
            where: { AND: [{ id }, this.scoped(user)] },
            select: {
                id: true,
                voucher_number: true,
                student_id: true,
                status: true,
                total_amount: true,
                pdf_url: true,
                paid_pdf_url: true,
                reissued_from_voucher_id: true,
                reissued_to: { select: { voucher_number: true } },
                _count: { select: { ec_deposits: true } },
            },
        });
        if (!v) throw new NotFoundException(`Extracurricular voucher #${id} not found`);
        if (v._count.ec_deposits > 0) throw new ConflictException(`${v.voucher_number} has payments recorded. Reverse them first.`);
        if (v.status === 'WAIVED') throw new ConflictException(`${v.voucher_number} is waived. Undo the waiver first.`);
        if (v.reissued_to) throw new ConflictException(`${v.voucher_number} was reissued as ${v.reissued_to.voucher_number}. Delete that one first.`);

        await this.prisma.$transaction(async (tx) => {
            await lockEcVoucher(tx, id);
            if ((await tx.ec_deposits.count({ where: { voucher_id: id } })) > 0) throw new ConflictException('A payment was just recorded on this voucher');
            if (v.reissued_from_voucher_id) {
                // A reissue: its charges go back to the voucher it replaced (lapsed again).
                await tx.ec_student_charges.updateMany({ where: { current_voucher_id: id }, data: { current_voucher_id: v.reissued_from_voucher_id } });
                await tx.ec_vouchers.delete({ where: { id } });
                await recomputeVoucherInTx(tx, v.reissued_from_voucher_id);
            } else {
                const stuck = await tx.ec_student_charges.count({ where: { current_voucher_id: id, OR: [{ amount_paid: { gt: 0 } }, { waived_amount: { gt: 0 } }] } });
                if (stuck) throw new ConflictException('Some charges on this voucher carry money from elsewhere; reverse it first');
                await tx.ec_student_charges.updateMany({ where: { current_voucher_id: id }, data: { current_voucher_id: null, status: 'NOT_ISSUED' } });
                await tx.ec_vouchers.delete({ where: { id } });
            }
        });

        for (const url of [v.pdf_url, v.paid_pdf_url]) if (url) void this.storage.deleteByUrl(url);
        await this.auditLogs.log({
            entity_type: 'EC_VOUCHER',
            entity_id: String(id),
            action: 'DELETED',
            section: 'finance',
            student_id: v.student_id,
            old_value: JSON.stringify({ voucher_number: v.voucher_number, total: Number(v.total_amount), reissued_from: v.reissued_from_voucher_id }),
            changed_by: actorOf(user),
        });
        return { id };
    }

    // ─── Export ────────────────────────────────────────────────────────────

    async exportExcel(user: IJwtStaffPayload, query: EcVoucherFilterDto): Promise<Buffer> {
        const where = await this.filterWhere(user, query);
        const rows = await this.prisma.ec_vouchers.findMany({ where, select: LIST_SELECT, orderBy: [{ issue_date: 'desc' }, { id: 'desc' }], take: 20_000 });
        const today = todayPktKey();
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Extracurricular vouchers');
        ws.columns = [
            { header: 'Voucher no.', key: 'no', width: 16 },
            { header: 'State', key: 'state', width: 14 },
            { header: 'Student', key: 'name', width: 28 },
            { header: 'C.C.', key: 'cc', width: 9 },
            { header: 'G.R.', key: 'gr', width: 12 },
            { header: 'Campus', key: 'campus', width: 18 },
            { header: 'Class', key: 'class', width: 16 },
            { header: 'Section', key: 'section', width: 10 },
            { header: 'Academic year', key: 'year', width: 12 },
            { header: 'Issue date', key: 'issue', width: 12 },
            { header: 'Valid till', key: 'expiry', width: 12 },
            { header: 'Total (Rs)', key: 'total', width: 12 },
            { header: 'Received (Rs)', key: 'paid', width: 13 },
            { header: 'Waived (Rs)', key: 'waived', width: 12 },
            { header: 'Balance (Rs)', key: 'balance', width: 12 },
        ];
        ws.getRow(1).font = { bold: true };
        for (const r of rows) {
            const v = listView(r, today);
            ws.addRow({
                no: v.voucher_number,
                state: v.state,
                name: v.student.full_name,
                cc: v.student.cc,
                gr: v.student.gr_number,
                campus: v.campus_name,
                class: v.class_name,
                section: v.section_name,
                year: v.academic_year,
                issue: v.issue_date,
                expiry: v.expiry_date,
                total: v.total_amount,
                paid: v.amount_paid,
                waived: v.amount_waived,
                balance: v.balance,
            });
        }
        return Buffer.from(await wb.xlsx.writeBuffer());
    }
}
