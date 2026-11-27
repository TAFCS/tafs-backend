import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ScopeService } from '../../../common/scope/scope.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { findStudentSearchHits } from '../../students/student-search-match';
import { normalizeEcAcademicYear } from '../ec-common.util';
import { dateKey, parseDateKey, todayPktDate, todayPktKey } from '../ec-dates.util';
import { ecStateWhere } from '../ec-voucher-state';
import { EC_VOUCHER_LIST_SELECT, EcVouchersService, ecVoucherListView } from '../vouchers/ec-vouchers.service';
import { EC_OUTSTANDING_STATES, EcOutstandingQueryDto, EcPaymentsQueryDto, EcReportFilterDto } from './dto/ec-reports.dto';

type Placement = { campus_id: number | null; class_id: number | null; section_id: number | null };

const PAYMENT_SELECT = {
    id: true,
    amount: true,
    deposit_date: true,
    payment_method: true,
    reference_number: true,
    bank_name: true,
    remarks: true,
    recorded_by_name: true,
    created_at: true,
    student_id: true,
    students: { select: { full_name: true, gr_number: true } },
    ec_vouchers: {
        select: {
            id: true,
            voucher_number: true,
            academic_year: true,
            campuses: { select: { campus_name: true } },
            classes: { select: { description: true } },
            sections: { select: { description: true } },
        },
    },
} as const;

/**
 * TAFSD-605: extracurricular reports, built only from the ec_* tables (the
 * academic financial reports never see EC money, and these never see academic
 * money).
 *
 *   Summary      per head: charged = received + waived + not issued + outstanding + lapsed.
 *                A charge on a voucher counts at the voucher's placement; one not yet
 *                issued counts at the student's current placement.
 *   Outstanding  per voucher: open (valid) and lapsed (expired, not reissued) balances.
 *   Payments     money received, by the day it was paid.
 */
@Injectable()
export class EcReportsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly scope: ScopeService,
        private readonly vouchers: EcVouchersService,
    ) {}

    // ─── Summary by head ──────────────────────────────────────────────────

    async summary(user: IJwtStaffPayload, f: EcReportFilterDto) {
        for (const c of f.campus_ids ?? []) this.scope.assertCampus(user, c);
        const years = (f.academic_years ?? []).map(normalizeEcAcademicYear);
        const [charges, classes] = await Promise.all([
            this.prisma.ec_student_charges.findMany({
                where: {
                    ...(years.length ? { academic_year: { in: years } } : {}),
                    ...(f.fee_head_ids?.length ? { fee_head_id: { in: f.fee_head_ids } } : {}),
                },
                select: {
                    student_id: true,
                    fee_head_id: true,
                    amount: true,
                    amount_paid: true,
                    waived_amount: true,
                    ec_fee_heads: { select: { name: true, sort_order: true } },
                    students: { select: { campus_id: true, class_id: true, section_id: true } },
                    current_voucher: { select: { campus_id: true, class_id: true, section_id: true, status: true, expiry_date: true } },
                },
            }),
            this.prisma.classes.findMany({ select: { id: true, segment_id: true } }),
        ]);
        const segmentOf = new Map(classes.map((c) => [c.id, c.segment_id]));
        const today = todayPktKey();
        const has = (ids: number[] | undefined, v: number | null) => !ids?.length || (v != null && ids.includes(v));

        type Row = { fee_head_id: number; name: string; sort_order: number; charged: number; received: number; waived: number; not_issued: number; outstanding: number; lapsed: number; students: Set<number> };
        const byHead = new Map<number, Row>();
        for (const c of charges) {
            const placement: Placement = c.current_voucher ?? c.students;
            if (!has(f.campus_ids, placement.campus_id) || !has(f.class_ids, placement.class_id) || !has(f.section_ids, placement.section_id)) continue;
            if (!this.scope.canSeeStudent(user, { ...placement, segment_id: placement.class_id != null ? segmentOf.get(placement.class_id) ?? null : null })) continue;

            const row = byHead.get(c.fee_head_id) ?? {
                fee_head_id: c.fee_head_id,
                name: c.ec_fee_heads.name,
                sort_order: c.ec_fee_heads.sort_order,
                charged: 0,
                received: 0,
                waived: 0,
                not_issued: 0,
                outstanding: 0,
                lapsed: 0,
                students: new Set<number>(),
            };
            const amount = Number(c.amount);
            const paid = Number(c.amount_paid);
            const waived = Number(c.waived_amount);
            const rest = Math.max(amount - paid - waived, 0);
            row.charged += amount;
            row.received += paid;
            row.waived += waived;
            if (!c.current_voucher) row.not_issued += rest;
            else if (dateKey(c.current_voucher.expiry_date) < today && (c.current_voucher.status === 'UNPAID' || c.current_voucher.status === 'PARTIALLY_PAID')) row.lapsed += rest;
            else row.outstanding += rest;
            row.students.add(c.student_id);
            byHead.set(c.fee_head_id, row);
        }

        const rows = [...byHead.values()]
            .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
            .map(({ students, sort_order: _s, ...r }) => ({ ...r, students: students.size, balanced: r.charged === r.received + r.waived + r.not_issued + r.outstanding + r.lapsed }));
        const sum = (k: 'charged' | 'received' | 'waived' | 'not_issued' | 'outstanding' | 'lapsed') => rows.reduce((n, r) => n + r[k], 0);
        const totals = {
            charged: sum('charged'),
            received: sum('received'),
            waived: sum('waived'),
            not_issued: sum('not_issued'),
            outstanding: sum('outstanding'),
            lapsed: sum('lapsed'),
        };
        return {
            rows,
            totals: { ...totals, balanced: totals.charged === totals.received + totals.waived + totals.not_issued + totals.outstanding + totals.lapsed },
        };
    }

    // ─── Outstanding & lapsed ─────────────────────────────────────────────

    private async outstandingWhere(user: IJwtStaffPayload, q: EcOutstandingQueryDto) {
        const states = q.states?.length ? q.states : [...EC_OUTSTANDING_STATES];
        return this.vouchers.filterWhere(user, {
            q: q.q,
            campus_ids: q.campus_ids,
            class_ids: q.class_ids,
            section_ids: q.section_ids,
            fee_head_ids: q.fee_head_ids,
            academic_years: q.academic_years,
            states,
        });
    }

    async outstanding(user: IJwtStaffPayload, q: EcOutstandingQueryDto) {
        const page = q.page ?? 1;
        const limit = q.limit ?? 50;
        const where = await this.outstandingWhere(user, q);
        const today = todayPktDate();
        const sumOf = async (extra: Prisma.ec_vouchersWhereInput | undefined) => {
            const a = await this.prisma.ec_vouchers.aggregate({ where: { AND: [where, ...(extra ? [extra] : [])] }, _sum: { total_amount: true, amount_paid: true, amount_waived: true }, _count: true });
            return { count: a._count, balance: Number(a._sum.total_amount ?? 0) - Number(a._sum.amount_paid ?? 0) - Number(a._sum.amount_waived ?? 0) };
        };
        const [total, rows, open, lapsed] = await Promise.all([
            this.prisma.ec_vouchers.count({ where }),
            this.prisma.ec_vouchers.findMany({ where, select: EC_VOUCHER_LIST_SELECT, orderBy: [{ expiry_date: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
            sumOf(ecStateWhere(['UNPAID', 'PARTIALLY_PAID'], today)),
            sumOf(ecStateWhere(['EXPIRED'], today)),
        ]);
        const key = todayPktKey();
        return {
            items: rows.map((r) => ecVoucherListView(r, key)),
            meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
            summary: { open_count: open.count, open_balance: open.balance, lapsed_count: lapsed.count, lapsed_balance: lapsed.balance },
        };
    }

    // ─── Payments ─────────────────────────────────────────────────────────

    private async paymentsWhere(user: IJwtStaffPayload, q: EcPaymentsQueryDto): Promise<Prisma.ec_depositsWhereInput> {
        for (const c of q.campus_ids ?? []) this.scope.assertCampus(user, c);
        const years = (q.academic_years ?? []).map(normalizeEcAcademicYear);
        const voucher: Prisma.ec_vouchersWhereInput = {
            AND: [
                this.scope.whereForVouchers(user) as Prisma.ec_vouchersWhereInput,
                q.campus_ids?.length ? { campus_id: { in: q.campus_ids } } : {},
                q.class_ids?.length ? { class_id: { in: q.class_ids } } : {},
                q.section_ids?.length ? { section_id: { in: q.section_ids } } : {},
                years.length ? { academic_year: { in: years } } : {},
            ],
        };
        const and: Prisma.ec_depositsWhereInput[] = [{ ec_vouchers: voucher }];
        if (q.payment_methods?.length) and.push({ payment_method: { in: q.payment_methods } });
        if (q.fee_head_ids?.length) and.push({ ec_deposit_allocations: { some: { ec_student_charges: { fee_head_id: { in: q.fee_head_ids } } } } });
        if (q.date_from || q.date_to) {
            and.push({ deposit_date: { ...(q.date_from ? { gte: parseDateKey(q.date_from, 'From') } : {}), ...(q.date_to ? { lte: parseDateKey(q.date_to, 'To') } : {}) } });
        }
        const text = (q.q ?? '').trim();
        if (text) {
            const or: Prisma.ec_depositsWhereInput[] = [{ reference_number: { contains: text, mode: 'insensitive' } }];
            const digits = text.replace(/^ec/i, '').replace(/\s+/g, '');
            if (/^\d{3,}$/.test(digits)) or.push({ ec_vouchers: { voucher_number: { contains: digits } } });
            const hits = await findStudentSearchHits(this.prisma, text, 500);
            if (hits.length) or.push({ student_id: { in: hits.map((h) => h.cc) } });
            and.push({ OR: or });
        }
        return { AND: and };
    }

    async payments(user: IJwtStaffPayload, q: EcPaymentsQueryDto) {
        const page = q.page ?? 1;
        const limit = q.limit ?? 50;
        const where = await this.paymentsWhere(user, q);
        const [total, rows, sum, byMethod, allocations] = await Promise.all([
            this.prisma.ec_deposits.count({ where }),
            this.prisma.ec_deposits.findMany({ where, select: PAYMENT_SELECT, orderBy: [{ deposit_date: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
            this.prisma.ec_deposits.aggregate({ where, _sum: { amount: true } }),
            this.prisma.ec_deposits.groupBy({ by: ['payment_method'], where, _sum: { amount: true }, _count: true }),
            this.prisma.ec_deposit_allocations.findMany({
                where: { ec_deposits: where },
                select: { amount: true, ec_student_charges: { select: { fee_head_id: true, ec_fee_heads: { select: { name: true } } } } },
            }),
        ]);
        const byHead = new Map<number, { fee_head_id: number; name: string; amount: number }>();
        for (const a of allocations) {
            const id = a.ec_student_charges.fee_head_id;
            const row = byHead.get(id) ?? { fee_head_id: id, name: a.ec_student_charges.ec_fee_heads.name, amount: 0 };
            row.amount += Number(a.amount);
            byHead.set(id, row);
        }
        return {
            items: rows.map((d) => this.paymentView(d)),
            meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
            summary: {
                count: total,
                amount: Number(sum._sum.amount ?? 0),
                by_method: byMethod.map((m) => ({ payment_method: m.payment_method, count: m._count, amount: Number(m._sum.amount ?? 0) })).sort((a, b) => b.amount - a.amount),
                by_head: [...byHead.values()].sort((a, b) => b.amount - a.amount),
            },
        };
    }

    private paymentView(d: Prisma.ec_depositsGetPayload<{ select: typeof PAYMENT_SELECT }>) {
        return {
            id: d.id,
            amount: Number(d.amount),
            deposit_date: dateKey(d.deposit_date),
            payment_method: d.payment_method,
            reference_number: d.reference_number,
            bank_name: d.bank_name,
            remarks: d.remarks,
            recorded_by_name: d.recorded_by_name,
            created_at: d.created_at,
            student: { cc: d.student_id, full_name: d.students.full_name, gr_number: d.students.gr_number },
            voucher: { id: d.ec_vouchers.id, voucher_number: d.ec_vouchers.voucher_number, academic_year: d.ec_vouchers.academic_year },
            campus_name: d.ec_vouchers.campuses.campus_name,
            class_name: d.ec_vouchers.classes.description,
            section_name: d.ec_vouchers.sections?.description ?? null,
        };
    }

    // ─── Exports ──────────────────────────────────────────────────────────

    private async workbook(sheet: string, columns: { header: string; key: string; width: number }[], rows: Record<string, unknown>[]): Promise<Buffer> {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet(sheet);
        ws.columns = columns;
        ws.getRow(1).font = { bold: true };
        for (const r of rows) ws.addRow(r);
        return Buffer.from(await wb.xlsx.writeBuffer());
    }

    async exportSummary(user: IJwtStaffPayload, f: EcReportFilterDto) {
        const { rows, totals } = await this.summary(user, f);
        return this.workbook(
            'Summary by head',
            [
                { header: 'Head', key: 'name', width: 28 },
                { header: 'Students', key: 'students', width: 10 },
                { header: 'Charged (Rs)', key: 'charged', width: 14 },
                { header: 'Received (Rs)', key: 'received', width: 14 },
                { header: 'Waived (Rs)', key: 'waived', width: 12 },
                { header: 'Not issued (Rs)', key: 'not_issued', width: 14 },
                { header: 'Outstanding (Rs)', key: 'outstanding', width: 15 },
                { header: 'Lapsed (Rs)', key: 'lapsed', width: 12 },
            ],
            [...rows, { name: 'TOTAL', students: '', ...totals }],
        );
    }

    async exportOutstanding(user: IJwtStaffPayload, q: EcOutstandingQueryDto) {
        const where = await this.outstandingWhere(user, q);
        const rows = await this.prisma.ec_vouchers.findMany({ where, select: EC_VOUCHER_LIST_SELECT, orderBy: [{ expiry_date: 'asc' }, { id: 'asc' }], take: 20_000 });
        const key = todayPktKey();
        return this.workbook(
            'Outstanding and lapsed',
            [
                { header: 'Voucher no.', key: 'no', width: 16 },
                { header: 'State', key: 'state', width: 14 },
                { header: 'Student', key: 'name', width: 28 },
                { header: 'C.C.', key: 'cc', width: 9 },
                { header: 'G.R.', key: 'gr', width: 12 },
                { header: 'Campus', key: 'campus', width: 18 },
                { header: 'Class', key: 'class', width: 16 },
                { header: 'Section', key: 'section', width: 10 },
                { header: 'Valid till', key: 'expiry', width: 12 },
                { header: 'Total (Rs)', key: 'total', width: 12 },
                { header: 'Received (Rs)', key: 'paid', width: 13 },
                { header: 'Balance (Rs)', key: 'balance', width: 12 },
            ],
            rows.map((r) => {
                const v = ecVoucherListView(r, key);
                return {
                    no: v.voucher_number,
                    state: v.state,
                    name: v.student.full_name,
                    cc: v.student.cc,
                    gr: v.student.gr_number,
                    campus: v.campus_name,
                    class: v.class_name,
                    section: v.section_name,
                    expiry: v.expiry_date,
                    total: v.total_amount,
                    paid: v.amount_paid,
                    balance: v.balance,
                };
            }),
        );
    }

    async exportPayments(user: IJwtStaffPayload, q: EcPaymentsQueryDto) {
        const where = await this.paymentsWhere(user, q);
        const rows = await this.prisma.ec_deposits.findMany({ where, select: PAYMENT_SELECT, orderBy: [{ deposit_date: 'desc' }, { id: 'desc' }], take: 50_000 });
        return this.workbook(
            'Payments',
            [
                { header: 'Paid on', key: 'date', width: 12 },
                { header: 'Amount (Rs)', key: 'amount', width: 12 },
                { header: 'Method', key: 'method', width: 14 },
                { header: 'Reference', key: 'ref', width: 16 },
                { header: 'Bank', key: 'bank', width: 16 },
                { header: 'Voucher no.', key: 'no', width: 16 },
                { header: 'Student', key: 'name', width: 28 },
                { header: 'C.C.', key: 'cc', width: 9 },
                { header: 'Campus', key: 'campus', width: 18 },
                { header: 'Class', key: 'class', width: 16 },
                { header: 'Recorded by', key: 'by', width: 18 },
            ],
            rows.map((d) => {
                const p = this.paymentView(d);
                return {
                    date: p.deposit_date,
                    amount: p.amount,
                    method: p.payment_method,
                    ref: p.reference_number,
                    bank: p.bank_name,
                    no: p.voucher.voucher_number,
                    name: p.student.full_name,
                    cc: p.student.cc,
                    campus: p.campus_name,
                    class: [p.class_name, p.section_name].filter(Boolean).join(' '),
                    by: p.recorded_by_name,
                };
            }),
        );
    }
}
