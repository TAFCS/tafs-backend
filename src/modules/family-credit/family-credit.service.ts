import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScopeService } from '../../common/scope/scope.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { findStudentSearchHits } from '../students/student-search-match';
import {
    FAMILY_CREDIT_KIND,
    FAMILY_CREDIT_KIND_LABEL,
    FamilyCreditKind,
    MANUAL_FAMILY_CREDIT_KINDS,
    REFUND_METHODS,
    RefundMethod,
    assertBalanceCovers,
    assertManualAmount,
    assertReason,
    lockFamilyCreditBalances,
    rowsToUndo,
    rs,
    undoEntries,
} from '../vouchers/family-credit';
import { FamilyCreditListQueryDto } from './dto/family-credit.dto';

const INT4_MAX = 2_147_483_647;
const SEARCH_SIMPLE_LIMIT = 10;

type Staff = IJwtStaffPayload;

type FamilyAggregate = { family_id: number; balance: Prisma.Decimal; last_movement_at: Date | null; entries: number };

const STUDENT_SELECT = {
    cc: true,
    full_name: true,
    gr_number: true,
    family_id: true,
    campus_id: true,
    class_id: true,
    section_id: true,
    campuses: { select: { campus_name: true } },
    classes: { select: { description: true, segment_id: true } },
    sections: { select: { description: true } },
} as const;
type StudentRow = Prisma.studentsGetPayload<{ select: typeof STUDENT_SELECT }>;

const studentView = (s: StudentRow) => ({
    cc: s.cc,
    full_name: s.full_name,
    gr_number: s.gr_number,
    campus_id: s.campus_id,
    campus_name: s.campuses?.campus_name ?? null,
    class_name: s.classes?.description ?? null,
    section_name: s.sections?.description ?? null,
});

/**
 * TAFSD-504: the Family Credit tile. Lists who holds credit, shows a family's
 * whole ledger, and writes the manual entries (add, deduct, refund, move to
 * another family, undo). Every write is an append-only row in
 * family_credit_ledger taken under the family row lock, and none of them is a
 * deposit: no cash report, voucher or fee head ever sees a manual entry.
 *
 * Visibility follows the deposit screen's rule: a family is visible when the
 * caller can see at least one of its students. A family whose students have
 * all been removed is visible only to an unrestricted caller.
 */
@Injectable()
export class FamilyCreditService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly scope: ScopeService,
        private readonly auditLogs: AuditLogsService,
    ) {}

    // ─── Reads ─────────────────────────────────────────────────────────────

    private async aggregates(familyIds?: number[]): Promise<FamilyAggregate[]> {
        if (familyIds && familyIds.length === 0) return [];
        const rows = await this.prisma.$queryRaw<
            { family_id: number; balance: Prisma.Decimal | null; last_movement_at: Date | null; entries: bigint }[]
        >(Prisma.sql`
            SELECT family_id, SUM(amount) AS balance, MAX(created_at) AS last_movement_at, COUNT(*) AS entries
            FROM public.family_credit_ledger
            ${familyIds ? Prisma.sql`WHERE family_id IN (${Prisma.join(familyIds)})` : Prisma.empty}
            GROUP BY family_id
        `);
        return rows.map((r) => ({
            family_id: Number(r.family_id),
            balance: new Prisma.Decimal(r.balance ?? 0),
            last_movement_at: r.last_movement_at,
            entries: Number(r.entries),
        }));
    }

    /** Family ids a search text could mean: family number, name, legacy id, or any student in it. */
    private async familyIdsMatching(q: string): Promise<Set<number>> {
        const text = q.trim();
        const ids = new Set<number>();
        if (!text) return ids;
        const number = /^\d+$/.test(text) && Number(text) <= INT4_MAX ? Number(text) : null;
        const famOr: Prisma.familiesWhereInput[] = [
            { household_name: { contains: text, mode: 'insensitive' } },
            { legacy_pid: { contains: text, mode: 'insensitive' } },
        ];
        if (number != null) famOr.push({ id: number });
        const [fams, hits] = await Promise.all([
            this.prisma.families.findMany({ where: { deleted_at: null, OR: famOr }, select: { id: true }, take: 500 }),
            findStudentSearchHits(this.prisma, text, 500),
        ]);
        for (const f of fams) ids.add(f.id);
        if (hits.length) {
            const studs = await this.prisma.students.findMany({
                where: { cc: { in: hits.map((h) => h.cc) }, family_id: { not: null } },
                select: { family_id: true },
            });
            for (const s of studs) ids.add(s.family_id!);
        }
        return ids;
    }

    /**
     * The visible students of each family, narrowed by the caller's scope and the
     * campus filter. Requested campuses outside scope are refused.
     */
    private async visibleStudents(user: Staff, familyIds: number[], campusIds: number[] = []) {
        for (const c of campusIds) this.scope.assertCampus(user, c);
        if (familyIds.length === 0) return new Map<number, StudentRow[]>();
        const where: Prisma.studentsWhereInput = {
            AND: [
                { family_id: { in: familyIds }, deleted_at: null },
                campusIds.length ? { campus_id: { in: campusIds } } : {},
                this.scope.whereForStudents(user) as Prisma.studentsWhereInput,
            ],
        };
        const rows = await this.prisma.students.findMany({ where, select: STUDENT_SELECT, orderBy: { cc: 'asc' } });
        const byFamily = new Map<number, StudentRow[]>();
        for (const s of rows) {
            const list = byFamily.get(s.family_id!) ?? [];
            list.push(s);
            byFamily.set(s.family_id!, list);
        }
        return byFamily;
    }

    /** Family ids among `familyIds` that have no current students at all. */
    private async familiesWithoutStudents(familyIds: number[]): Promise<Set<number>> {
        if (familyIds.length === 0) return new Set();
        const withStudents = await this.prisma.students.findMany({
            where: { family_id: { in: familyIds }, deleted_at: null },
            select: { family_id: true },
            distinct: ['family_id'],
        });
        const has = new Set(withStudents.map((s) => s.family_id!));
        return new Set(familyIds.filter((id) => !has.has(id)));
    }

    /** Families with ledger rows that pass the filters, sorted. */
    private async filteredFamilies(query: FamilyCreditListQueryDto, user: Staff) {
        const campusIds = query.campus_ids ?? [];
        let aggs = await this.aggregates();
        if (!query.include_zero) aggs = aggs.filter((a) => !a.balance.eq(0));
        const q = (query.q ?? '').trim();
        if (q) {
            const matching = await this.familyIdsMatching(q);
            aggs = aggs.filter((a) => matching.has(a.family_id));
        }
        const ids = aggs.map((a) => a.family_id);
        const students = await this.visibleStudents(user, ids, campusIds);
        // Credit outlives the children: a family whose students are all gone can
        // still be owed a refund. Only an unrestricted caller can see those.
        const orphans =
            campusIds.length === 0 && this.scope.isUnrestricted(user)
                ? await this.familiesWithoutStudents(ids.filter((id) => !students.has(id)))
                : new Set<number>();
        aggs = aggs.filter((a) => students.has(a.family_id) || orphans.has(a.family_id));

        const families = await this.prisma.families.findMany({
            where: { id: { in: aggs.map((a) => a.family_id) } },
            select: { id: true, household_name: true, legacy_pid: true, deleted_at: true },
        });
        const famById = new Map(families.map((f) => [f.id, f]));
        const rows = aggs.map((a) => {
            const f = famById.get(a.family_id);
            return {
                family_id: a.family_id,
                household_name: f?.household_name ?? `Family #${a.family_id}`,
                legacy_pid: f?.legacy_pid ?? null,
                family_deleted: f?.deleted_at != null,
                balance: Number(a.balance),
                last_movement_at: a.last_movement_at,
                entries: a.entries,
                students: (students.get(a.family_id) ?? []).map(studentView),
            };
        });

        const dir = query.sort_dir === 'asc' ? 1 : -1;
        const sortBy = query.sort_by ?? 'balance';
        rows.sort((x, y) => {
            let c = 0;
            if (sortBy === 'family') c = x.household_name.localeCompare(y.household_name);
            else if (sortBy === 'last_movement')
                c = (x.last_movement_at?.getTime() ?? 0) - (y.last_movement_at?.getTime() ?? 0);
            else c = x.balance - y.balance;
            return c * dir || x.family_id - y.family_id;
        });
        return rows;
    }

    async list(query: FamilyCreditListQueryDto, user: Staff) {
        const rows = await this.filteredFamilies(query, user);
        const page = Math.max(1, query.page ?? 1);
        const limit = Math.min(200, Math.max(1, query.limit ?? 50));
        const total_balance = rows.reduce((s, r) => s.add(r.balance), new Prisma.Decimal(0));
        return {
            items: rows.slice((page - 1) * limit, page * limit),
            meta: { page, limit, total: rows.length, total_pages: Math.max(1, Math.ceil(rows.length / limit)) },
            totals: {
                families: rows.length,
                families_holding_credit: rows.filter((r) => r.balance > 0).length,
                total_balance: Number(total_balance),
            },
        };
    }

    /**
     * Rule 2 search: any family the caller can see, holding credit or not (the
     * transfer target and "add credit to a family" pickers need both). Small
     * projection; empty text returns nothing.
     */
    async searchSimple(qRaw: string | undefined, user: Staff, campusIds: number[] = []) {
        const q = (qRaw ?? '').trim();
        if (!q) return [];
        const matching = [...(await this.familyIdsMatching(q))];
        const students = await this.visibleStudents(user, matching, campusIds);
        const visibleIds = matching.filter((id) => students.has(id));
        const [families, aggs] = await Promise.all([
            this.prisma.families.findMany({
                where: { id: { in: visibleIds }, deleted_at: null },
                select: { id: true, household_name: true, legacy_pid: true },
            }),
            this.aggregates(visibleIds),
        ]);
        const balance = new Map(aggs.map((a) => [a.family_id, Number(a.balance)]));
        const number = /^\d+$/.test(q) ? Number(q) : null;
        return families
            .sort((a, b) => (a.id === number ? -1 : b.id === number ? 1 : a.household_name.localeCompare(b.household_name)))
            .slice(0, SEARCH_SIMPLE_LIMIT)
            .map((f) => ({
                family_id: f.id,
                household_name: f.household_name,
                legacy_pid: f.legacy_pid,
                balance: balance.get(f.id) ?? 0,
                students: (students.get(f.id) ?? []).slice(0, 4).map((s) => ({
                    cc: s.cc,
                    full_name: s.full_name,
                    gr_number: s.gr_number,
                    class_name: s.classes?.description ?? null,
                })),
            }));
    }

    /** 404 unless the caller can see the family. Returns the family and its visible students. */
    private async assertFamilyVisible(familyId: number, user: Staff) {
        const family = await this.prisma.families.findUnique({
            where: { id: familyId },
            select: { id: true, household_name: true, legacy_pid: true, deleted_at: true },
        });
        if (!family) throw new NotFoundException(`Family ${familyId} not found`);
        const students = (await this.visibleStudents(user, [familyId])).get(familyId) ?? [];
        if (students.length === 0) {
            const orphan = this.scope.isUnrestricted(user) && (await this.familiesWithoutStudents([familyId])).has(familyId);
            if (!orphan) throw new NotFoundException(`Family ${familyId} not found`);
        }
        return { family, students };
    }

    async detail(familyId: number, user: Staff) {
        const { family, students } = await this.assertFamilyVisible(familyId, user);
        const rows = await this.prisma.family_credit_ledger.findMany({
            where: { family_id: familyId },
            orderBy: { id: 'desc' },
        });
        const studentIds = [...new Set(rows.map((r) => r.student_id).filter((v): v is number => v != null))];
        const counterpartIds = [...new Set(rows.map((r) => r.counterpart_family_id).filter((v): v is number => v != null))];
        const rowIds = rows.map((r) => r.id);
        // Undo rows can live on the other family (a transfer's other half), so
        // look them up across the ledger, not just in this family's rows.
        const [names, counterparts, undos, pairs] = await Promise.all([
            this.prisma.students.findMany({ where: { cc: { in: studentIds } }, select: { cc: true, full_name: true } }),
            this.prisma.families.findMany({ where: { id: { in: counterpartIds } }, select: { id: true, household_name: true } }),
            this.prisma.family_credit_ledger.findMany({
                where: { reverses_entry_id: { in: rowIds } },
                select: { id: true, reverses_entry_id: true },
            }),
            this.prisma.family_credit_ledger.findMany({
                where: { linked_entry_id: { in: rowIds } },
                select: { id: true, linked_entry_id: true },
            }),
        ]);
        const nameOf = new Map(names.map((s) => [s.cc, s.full_name]));
        const counterpartName = new Map(counterparts.map((f) => [f.id, f.household_name]));
        const undoneBy = new Map(undos.map((u) => [u.reverses_entry_id!, u.id]));
        const pairOf = new Map<number, number>();
        for (const p of pairs) pairOf.set(p.linked_entry_id!, p.id);
        for (const r of rows) if (r.linked_entry_id != null) pairOf.set(r.id, r.linked_entry_id);
        // A transfer is undone as a pair, so either half being undone undoes both.
        const undone = (id: number) => undoneBy.get(id) ?? (pairOf.has(id) ? undoneBy.get(pairOf.get(id)!) : undefined) ?? null;

        const balance = rows.reduce((s, r) => s.add(r.amount), new Prisma.Decimal(0));
        return {
            family_id: family.id,
            household_name: family.household_name,
            legacy_pid: family.legacy_pid,
            family_deleted: family.deleted_at != null,
            balance: Number(balance),
            students: students.map(studentView),
            entries: rows.map((r) => {
                const undoneByEntry = undone(r.id);
                return {
                    id: r.id,
                    amount: Number(r.amount),
                    kind: r.kind,
                    kind_label: FAMILY_CREDIT_KIND_LABEL[r.kind as FamilyCreditKind] ?? r.kind,
                    student_id: r.student_id,
                    student_name: r.student_id != null ? nameOf.get(r.student_id) ?? null : null,
                    voucher_id: r.voucher_id,
                    deposit_id: r.deposit_id,
                    notes: r.notes,
                    method: r.method,
                    created_by: r.created_by,
                    created_at: r.created_at,
                    counterpart_family_id: r.counterpart_family_id,
                    counterpart_family_name:
                        r.counterpart_family_id != null ? counterpartName.get(r.counterpart_family_id) ?? null : null,
                    reverses_entry_id: r.reverses_entry_id,
                    undone_by_entry_id: undoneByEntry,
                    can_undo:
                        MANUAL_FAMILY_CREDIT_KINDS.includes(r.kind as FamilyCreditKind) && undoneByEntry == null,
                };
            }),
        };
    }

    // ─── Writes ────────────────────────────────────────────────────────────

    private by(user: Staff) {
        return String(user?.username || user?.sub || 'system').slice(0, 100);
    }

    private async audit(user: Staff, familyId: number, kind: FamilyCreditKind, amount: Prisma.Decimal, note: string) {
        await this.auditLogs.log({
            entity_type: 'FAMILY_CREDIT',
            entity_id: String(familyId),
            action: 'CREATED',
            field: kind,
            new_value: amount.toFixed(2),
            changed_by: this.by(user),
            note,
        });
    }

    /** One manual entry on one family, under that family's lock. */
    private async writeSingle(
        familyId: number,
        user: Staff,
        kind: FamilyCreditKind,
        amountIn: number,
        reasonIn: string,
        method?: RefundMethod,
    ) {
        const amount = assertManualAmount(amountIn);
        const reason = assertReason(reasonIn);
        const { family } = await this.assertFamilyVisible(familyId, user);
        const takesOut = kind !== FAMILY_CREDIT_KIND.MANUAL_CREDIT;
        if (!takesOut && family.deleted_at) {
            throw new BadRequestException('This family record has been removed, so credit cannot be added to it.');
        }
        const signed = takesOut ? amount.negated() : amount;
        const row = await this.prisma.$transaction(async (tx) => {
            const balances = await lockFamilyCreditBalances(tx, [familyId]);
            if (takesOut) assertBalanceCovers(balances.get(familyId)!, amount);
            return tx.family_credit_ledger.create({
                data: {
                    family_id: familyId,
                    amount: signed,
                    kind,
                    notes: reason,
                    method: method ?? null,
                    created_by: this.by(user),
                },
            });
        });
        const label = FAMILY_CREDIT_KIND_LABEL[kind];
        await this.audit(user, familyId, kind, signed, `${label}: ${rs(amount)}${method ? ` by ${method.replace('_', ' ')}` : ''}. ${reason}`);
        return { entry_id: row.id, ...(await this.detail(familyId, user)) };
    }

    addCredit(familyId: number, amount: number, reason: string, user: Staff) {
        return this.writeSingle(familyId, user, FAMILY_CREDIT_KIND.MANUAL_CREDIT, amount, reason);
    }

    deductCredit(familyId: number, amount: number, reason: string, user: Staff) {
        return this.writeSingle(familyId, user, FAMILY_CREDIT_KIND.MANUAL_DEBIT, amount, reason);
    }

    refundCredit(familyId: number, amount: number, method: RefundMethod, reason: string, user: Staff) {
        if (!REFUND_METHODS.includes(method)) {
            throw new BadRequestException(`Refund method must be one of: ${REFUND_METHODS.join(', ')}.`);
        }
        return this.writeSingle(familyId, user, FAMILY_CREDIT_KIND.REFUNDED, amount, reason, method);
    }

    /** Moves credit to another family: one row out here, one row in there, in one transaction. */
    async transferCredit(fromFamilyId: number, toFamilyId: number, amountIn: number, reasonIn: string, user: Staff) {
        if (fromFamilyId === toFamilyId) throw new BadRequestException('Pick a different family to move the credit to.');
        const amount = assertManualAmount(amountIn);
        const reason = assertReason(reasonIn);
        const { family: from } = await this.assertFamilyVisible(fromFamilyId, user);
        const { family: to } = await this.assertFamilyVisible(toFamilyId, user);
        if (to.deleted_at) throw new BadRequestException('That family record has been removed, so credit cannot be moved to it.');

        const by = this.by(user);
        const [out] = await this.prisma.$transaction(async (tx) => {
            const balances = await lockFamilyCreditBalances(tx, [fromFamilyId, toFamilyId]);
            assertBalanceCovers(balances.get(fromFamilyId)!, amount);
            const outRow = await tx.family_credit_ledger.create({
                data: {
                    family_id: fromFamilyId,
                    amount: amount.negated(),
                    kind: FAMILY_CREDIT_KIND.TRANSFER_OUT,
                    counterpart_family_id: toFamilyId,
                    notes: reason,
                    created_by: by,
                },
            });
            const inRow = await tx.family_credit_ledger.create({
                data: {
                    family_id: toFamilyId,
                    amount,
                    kind: FAMILY_CREDIT_KIND.TRANSFER_IN,
                    counterpart_family_id: fromFamilyId,
                    linked_entry_id: outRow.id,
                    notes: reason,
                    created_by: by,
                },
            });
            return [outRow, inRow];
        });
        await this.audit(user, fromFamilyId, FAMILY_CREDIT_KIND.TRANSFER_OUT, amount.negated(),
            `${rs(amount)} moved to family #${toFamilyId} (${to.household_name}). ${reason}`);
        await this.audit(user, toFamilyId, FAMILY_CREDIT_KIND.TRANSFER_IN, amount,
            `${rs(amount)} moved in from family #${fromFamilyId} (${from.household_name}). ${reason}`);
        return { entry_id: out.id, ...(await this.detail(fromFamilyId, user)) };
    }

    /**
     * Undo a manual entry with opposite rows. A transfer is undone as a pair.
     * Refused for deposit entries (reverse the deposit), for an undo row, for an
     * entry already undone, and when the money has since been used.
     */
    async undoEntry(entryId: number, reasonIn: string, user: Staff) {
        const reason = assertReason(reasonIn);
        const entry = await this.prisma.family_credit_ledger.findUnique({ where: { id: entryId } });
        if (!entry) throw new NotFoundException(`Entry ${entryId} not found`);
        await this.assertFamilyVisible(entry.family_id, user);

        const by = this.by(user);
        let created: Array<{ family_id: number; amount: Prisma.Decimal; reverses_entry_id: number }>;
        try {
            created = await this.prisma.$transaction(async (tx) => {
                const pair =
                    entry.kind === FAMILY_CREDIT_KIND.TRANSFER_OUT
                        ? await tx.family_credit_ledger.findFirst({ where: { linked_entry_id: entry.id } })
                        : entry.kind === FAMILY_CREDIT_KIND.TRANSFER_IN && entry.linked_entry_id != null
                          ? await tx.family_credit_ledger.findUnique({ where: { id: entry.linked_entry_id } })
                          : null;
                const rows = rowsToUndo(entry, pair);
                const balances = await lockFamilyCreditBalances(tx, rows.map((r) => r.family_id));
                // Checked after the lock, so two staff clicking Undo together can't both pass.
                const already = await tx.family_credit_ledger.findFirst({
                    where: { reverses_entry_id: { in: rows.map((r) => r.id) } },
                    select: { id: true },
                });
                if (already) throw new ConflictException('This entry has already been undone.');
                const opposite = undoEntries(rows, balances);
                for (const o of opposite) {
                    const original = rows.find((r) => r.id === o.reverses_entry_id)!;
                    await tx.family_credit_ledger.create({
                        data: {
                            family_id: o.family_id,
                            amount: o.amount,
                            kind: FAMILY_CREDIT_KIND.ENTRY_REVERSED,
                            reverses_entry_id: o.reverses_entry_id,
                            counterpart_family_id: original.counterpart_family_id,
                            notes: reason,
                            created_by: by,
                        },
                    });
                }
                return opposite;
            });
        } catch (e: any) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
                throw new ConflictException('This entry has already been undone.');
            }
            throw e;
        }
        for (const o of created) {
            await this.audit(user, o.family_id, FAMILY_CREDIT_KIND.ENTRY_REVERSED, o.amount,
                `Undid entry #${o.reverses_entry_id} (${o.amount.isNegative() ? '-' : '+'}${rs(o.amount.abs())}). ${reason}`);
        }
        return this.detail(entry.family_id, user);
    }

    // ─── Export ────────────────────────────────────────────────────────────

    async exportExcel(query: FamilyCreditListQueryDto, user: Staff): Promise<Buffer> {
        const rows = await this.filteredFamilies(query, user);
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Family credit');
        ws.columns = [
            { header: 'Family #', key: 'family_id', width: 10 },
            { header: 'Family', key: 'household_name', width: 30 },
            { header: 'Legacy ID', key: 'legacy_pid', width: 12 },
            { header: 'Students (C.C. / G.R. / class)', key: 'students', width: 60 },
            { header: 'Campus', key: 'campus', width: 24 },
            { header: 'Balance (Rs.)', key: 'balance', width: 16 },
            { header: 'Last movement', key: 'last_movement_at', width: 18 },
            { header: 'Entries', key: 'entries', width: 9 },
        ];
        for (const r of rows) {
            ws.addRow({
                family_id: r.family_id,
                household_name: r.household_name,
                legacy_pid: r.legacy_pid ?? '',
                students: r.students
                    .map((s) => `${s.cc}${s.gr_number ? ` / ${s.gr_number}` : ''} ${s.full_name}${s.class_name ? ` (${s.class_name})` : ''}`)
                    .join('; '),
                campus: [...new Set(r.students.map((s) => s.campus_name).filter(Boolean))].join(', '),
                balance: r.balance,
                last_movement_at: r.last_movement_at ?? null,
                entries: r.entries,
            });
        }
        const total = rows.reduce((s, r) => s + r.balance, 0);
        const totalRow = ws.addRow({ household_name: `Total (${rows.length} families)`, balance: total });
        totalRow.font = { bold: true };
        ws.getRow(1).font = { bold: true };
        ws.getColumn('balance').numFmt = '#,##0.00';
        ws.getColumn('last_movement_at').numFmt = 'dd/mm/yyyy hh:mm';
        ws.views = [{ state: 'frozen', ySplit: 1 }];
        return Buffer.from(await wb.xlsx.writeBuffer());
    }
}
