import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { Prisma } from '@prisma/client';
import { BulkSaveStudentFeesDto, SaveStudentFeeItemDto } from './dto/bulk-save-student-fees.dto';
import { CreateBundleDto } from './dto/create-bundle.dto';
import { StudentsService } from '../students/students.service';
import {
    resolveTermStartMonth,
    DEFAULT_TERM_START_MONTH,
    getMonthYearLabel,
    termOfHead,
} from '../../common/utils/academic-labels';
import { getClassTermMap, termStartMonthForClass } from '../../common/utils/class-terms.util';

// An audit-log entry queued during a transaction/multi-step operation and
// flushed once the whole operation has committed.
type FeeAuditEvent = {
    entity_type: string;
    entity_id: string;
    action: string;
    field?: string | null;
    old_value?: string | null;
    new_value?: string | null;
    note: string;
};

@Injectable()
export class StudentFeesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly auditLogs: AuditLogsService,
        private readonly studentsService: StudentsService,
    ) { }

    // ─────────────────────────────────────────────────────────────────────────
    // Audit-logging helpers — every data-mutating method in this service must
    // leave a descriptive trail (student, fee type/period, before/after values)
    // so an admin can reconstruct exactly what happened to a student's fee
    // schedule, deposits, and vouchers.
    // ─────────────────────────────────────────────────────────────────────────

    private fmtDate(d: Date | string | null | undefined): string {
        if (!d) return 'N/A';
        return new Date(d).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    private fmtMoney(amount: Prisma.Decimal | number | string | null | undefined): string {
        if (amount === null || amount === undefined) return 'N/A';
        return `Rs. ${Number(amount).toLocaleString()}`;
    }

    // Human label for a fee head's billing period, e.g. "Aug 2025" — prefers the
    // exact fee_date, falls back to the target month/academic year.
    private periodLabel(targetMonth?: number | null, academicYear?: string | null, feeDate?: Date | null): string {
        if (feeDate) {
            return new Date(feeDate).toLocaleDateString('en-PK', { month: 'short', year: 'numeric' });
        }
        if (targetMonth) {
            const m = this.getMonthLabel(targetMonth);
            return academicYear ? `${m} ${academicYear}` : m;
        }
        return 'unscheduled';
    }

    private async flushAuditEvents(events: FeeAuditEvent[], studentId: number | null, changedBy: string) {
        if (events.length === 0) return;

        // First event is the parent summary; remaining events nest as children
        // so one user action appears as one top-level Activity Log row.
        const [parent, ...children] = events;
        if (children.length === 0) {
            await this.auditLogs.log({
                entity_type: parent.entity_type,
                entity_id: parent.entity_id,
                action: parent.action,
                field: parent.field ?? null,
                old_value: parent.old_value ?? null,
                new_value: parent.new_value ?? null,
                changed_by: changedBy,
                student_id: studentId,
                note: parent.note,
            });
            return;
        }

        await this.auditLogs.logGroup(
            {
                entity_type: parent.entity_type,
                entity_id: parent.entity_id,
                action: parent.action,
                field: parent.field ?? null,
                old_value: parent.old_value ?? null,
                new_value: parent.new_value ?? null,
                changed_by: changedBy,
                student_id: studentId,
                note: parent.note,
            },
            children.map((e) => ({
                entity_type: e.entity_type,
                entity_id: e.entity_id,
                action: e.action,
                field: e.field ?? null,
                old_value: e.old_value ?? null,
                new_value: e.new_value ?? null,
                student_id: studentId,
                note: e.note,
            })),
        );
    }

    async getMonthlyStatusForParent(studentCc: number, familyId: number) {
        const student = await this.prisma.students.findFirst({
            where: {
                cc: studentCc,
                family_id: familyId,
                deleted_at: null,
            },
            select: { cc: true },
        });

        if (!student) {
            throw new ForbiddenException(
                `Student #${studentCc} not linked to your family`,
            );
        }

        const fees = await this.prisma.student_fees.findMany({
            where: { student_id: studentCc },
            select: {
                academic_year: true,
                target_month: true,
                month: true,
                status: true,
                amount: true,
                amount_before_discount: true,
                amount_paid: true,
                fee_date: true,
                is_discount: true,
            },
        });
        const feesWithDiscount = fees;

        if (fees.length === 0) {
            return [];
        }

        type Bucket = {
            academicYear: string;
            targetMonth: number;
            monthLabel: string;
            totalAmount: number;
            totalPaid: number;
            outstanding: number;
            rowCount: number;
            notIssuedCount: number;
            feeDate: Date | null;
        };

        const grouped = new Map<string, Bucket>();

        for (const fee of feesWithDiscount) {
            const academicYear = fee.academic_year;
            const targetMonth = fee.target_month ?? fee.month ?? 0;
            if (!academicYear || targetMonth < 1 || targetMonth > 12) {
                continue;
            }

            // Discount rows reduce the total but have no amount_paid contribution
            const isDiscount = fee.is_discount === true;
            const rawAmount = Number(fee.amount ?? fee.amount_before_discount ?? 0);
            const amount = isDiscount ? -rawAmount : rawAmount;
            const paidRaw = isDiscount ? 0 : Number(fee.amount_paid ?? 0);
            const paid = Math.min(Math.max(paidRaw, 0), Math.max(rawAmount, 0));
            const outstanding = isDiscount ? 0 : Math.max(rawAmount - paid, 0);

            const key = `${academicYear}|${targetMonth}`;
            const existing = grouped.get(key);

            if (!existing) {
                grouped.set(key, {
                    academicYear,
                    targetMonth,
                    monthLabel: this.getMonthLabel(targetMonth),
                    totalAmount: amount,
                    totalPaid: paid,
                    outstanding,
                    rowCount: 1,
                    notIssuedCount: (fee.status === 'NOT_ISSUED' && !isDiscount) ? 1 : 0,
                    feeDate: fee.fee_date ?? null,
                });
                continue;
            }

            existing.totalAmount += amount;
            existing.totalPaid += paid;
            existing.outstanding += outstanding;
            existing.rowCount += 1;
            if (fee.status === 'NOT_ISSUED' && !isDiscount) {
                existing.notIssuedCount += 1;
            }
            if (!existing.feeDate && fee.fee_date) {
                existing.feeDate = fee.fee_date;
            }
        }

        const buckets = Array.from(grouped.values()).sort((a, b) => {
            const yearCmp = this.getAcademicYearSortKey(a.academicYear) - this.getAcademicYearSortKey(b.academicYear);
            if (yearCmp !== 0) return yearCmp;
            return a.targetMonth - b.targetMonth;
        });

        // Fetch ALL vouchers (including VOID) with heads to match with months for historical context
        const vouchers = await this.prisma.vouchers.findMany({
            where: {
                student_id: studentCc,
                released_to_parent_at: { not: null },
                OR: [
                    { status: { not: 'VOID' } },
                    {
                        status: 'VOID',
                        voucher_heads: {
                            some: {
                                amount_deposited: { gt: 0 }
                            }
                        }
                    }
                ]
            },
            include: {
                voucher_heads: {
                    include: {
                        student_fees: true
                    }
                }
            },
            orderBy: { issue_date: 'desc' },
        });


        let runningOutstanding = 0;

        return buckets
            .map((bucket) => {
                runningOutstanding += bucket.outstanding;

                // Find latest ACTIVE voucher that either belongs to this month 
                // OR contains heads for this month (like a later bill with arrears)
                const activeVoucher = vouchers.find((v) => {
                    if (v.status === 'VOID') return false;

                    const directMatch = v.academic_year === bucket.academicYear && v.month === bucket.targetMonth;
                    if (directMatch) return true;

                    return v.voucher_heads.some((h) => 
                        h.student_fees.academic_year === bucket.academicYear && 
                        (h.student_fees.target_month ?? h.student_fees.month) === bucket.targetMonth
                    );
                });

                const monthStatus =
                    bucket.outstanding <= 0
                        ? 'PAID'
                        : bucket.totalPaid > 0
                            ? 'PARTIALLY_PAID'
                            : !activeVoucher
                                ? 'NOT_ISSUED'
                                : bucket.notIssuedCount === bucket.rowCount
                                    ? 'NOT_ISSUED'
                                    : 'ISSUED';

                // For the primary month of the bill, show the FULL amount including all arrears.
                // For historical months where this voucher just contains arrears, we return null
                // so the frontend falls back to the monthly fee total (gross).
                let voucherMonthTotal: number | null = null;
                if (activeVoucher) {
                    const getAcademicMonthIndex = (m: number) => m >= 8 ? m - 8 : m + 4;
                    const voucherMonthIdx = activeVoucher.month;
                    const bucketMonthIdx = getAcademicMonthIndex(bucket.targetMonth);
                    
                    const isPrimaryMonth = activeVoucher.academic_year === bucket.academicYear && voucherMonthIdx === bucketMonthIdx;
                    
                    if (isPrimaryMonth) {
                        voucherMonthTotal = activeVoucher.voucher_heads.reduce(
                            (sum, h) => sum + Number(h.net_amount || 0), 0
                        );
                    }
                }

                return {
                    academic_year: bucket.academicYear,
                    target_month: bucket.targetMonth,
                    month_label: bucket.monthLabel,
                    month_total_amount: Number(bucket.totalAmount.toFixed(2)),
                    month_total_paid: Number(bucket.totalPaid.toFixed(2)),
                    month_total_outstanding: Number(bucket.outstanding.toFixed(2)),
                    running_outstanding_total: Number(runningOutstanding.toFixed(2)),
                    month_status: monthStatus,
                    fee_date: bucket.feeDate,
                    voucher_total: voucherMonthTotal,
                    voucher_id: activeVoucher?.id || null,
                };
            })
            .filter((m) => m.month_status !== 'NOT_ISSUED');
    }

    private getAcademicYearSortKey(academicYear: string) {
        const start = academicYear.split('-')[0]?.trim();
        const parsed = Number(start);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private getMonthLabel(month: number) {
        const labels = [
            'January',
            'February',
            'March',
            'April',
            'May',
            'June',
            'July',
            'August',
            'September',
            'October',
            'November',
            'December',
        ];

        if (month < 1 || month > 12) {
            return 'Unknown';
        }

        return labels[month - 1];
    }

    async findByStudent(studentId: number) {
        return this.prisma.student_fees.findMany({
            where: { student_id: studentId },
            include: {
                fee_types: true,
                student_fee_bundles: true,
            },
            orderBy: {
                fee_types: {
                    priority_order: 'asc',
                },
            },
        });
    }

    async findByStudentCC(ccNumber: string, dateFrom?: string, dateTo?: string) {
        const student = await this.prisma.students.findUnique({
            where: { cc: Number(ccNumber) },
            include: {
                families: {
                    include: {
                        students: {
                            where: { deleted_at: null },
                            include: {
                                classes: true,
                            },
                        },
                    },
                },
            },
        });

        if (!student) {
            throw new NotFoundException(`Student with CC number ${ccNumber} not found`);
        }

        // Build date filter for fee_date
        const feeDateFilter: any = {};
        if (dateFrom || dateTo) {
            feeDateFilter.fee_date = {};
            if (dateFrom) feeDateFilter.fee_date.gte = new Date(dateFrom);
            if (dateTo) feeDateFilter.fee_date.lte = new Date(dateTo);
        }

        const fees = await this.prisma.student_fees.findMany({
            where: {
                student_id: student.cc,
                ...(dateFrom || dateTo ? feeDateFilter : {}),
            },
            include: {
                fee_types: true,
                discount_presets: true,
                student_fee_bundles: {
                    include: {
                        student_fees: {
                            select: { installment_id: true }
                        }
                    }
                },
                student_fee_installments: {
                    include: { fee_types: true }
                },
                voucher_heads: {
                    orderBy: { id: 'desc' },
                    take: 1,
                    include: {
                        vouchers: {
                            select: { id: true, issue_date: true, status: true },
                        },
                    },
                },
            } as any,
            orderBy: [
                { fee_date: 'asc' },
                { fee_types: { priority_order: 'asc' } },
            ],
        });

        // ─── Calculate Installment Sequences (to help frontend labeling) ───
        const instIds = Array.from(new Set(fees.filter((f: any) => f.installment_id).map((f: any) => f.installment_id as number)));
        let allStudentInstFees: any[] = instIds.length > 0
            ? await this.prisma.student_fees.findMany({
                where: { student_id: student.cc, installment_id: { in: instIds } } as any,
                include: { student_fee_installments: true } as any,
            }) as any[]
            : [];

        const seqMap = new Map<number, number>(); // fee_id -> seq (1-indexed)
        const countMap = new Map<number, number>(); // inst_id -> standalone count
        instIds.forEach((id: number) => {
            const group = allStudentInstFees.filter((f: any) => f.installment_id === id);
            const instFeeTypeId = group.find((f: any) => f.student_fee_installments?.fee_type_id)
                ?.student_fee_installments?.fee_type_id;
            // Standalone fees only — sorted by fee_date so position reflects the payment schedule
            const standalones = group
                .filter((f: any) => !instFeeTypeId || f.fee_type_id === instFeeTypeId)
                .sort((a: any, b: any) => {
                    const aDate = a.fee_date ? new Date(a.fee_date).getTime() : 0;
                    const bDate = b.fee_date ? new Date(b.fee_date).getTime() : 0;
                    return aDate - bDate;
                });
            countMap.set(id, standalones.length);
            standalones.forEach((f: any, idx: number) => seqMap.set(f.id, idx + 1));
        });

        const enhancedFees = fees.map(f => {
            const isInstallment = !!(f as any).installment_id || !!(f as any).student_fee_installments;
            const hasInstallmentMerged = !!(f as any).bundle_id && 
                ((f as any).student_fee_bundles?.student_fees?.some((sf: any) => !!sf.installment_id) ?? false);

            return {
                ...f,
                installment_sequence: seqMap.get(f.id) || null,
                installment_total: (f as any).installment_id ? countMap.get((f as any).installment_id) : null,
                is_installment: isInstallment,
                has_installment_merged: hasInstallmentMerged
            };
        });

        // Group fees by fee_date
        const groupMap = new Map<string, any[]>();
        const ungrouped: any[] = [];

        for (const fee of enhancedFees) {
            if (fee.fee_date) {
                const key = fee.fee_date.toISOString().split('T')[0];
                if (!groupMap.has(key)) groupMap.set(key, []);
                groupMap.get(key)!.push(fee);
            } else {
                ungrouped.push(fee);
            }
        }

        const groups = Array.from(groupMap.entries()).map(([fee_date, groupFees]) => ({
            fee_date,
            fees: groupFees,
        }));

        return {
            groups,
            ungrouped,
            fees: enhancedFees, // Keep backward compat — flat list
            family: student.families,
        };
    }

    /**
     * Gets the definitive fee schedule for a student and academic year.
     * Follows the Strict Rule:
     * - If any student_fees records exist for the year -> return ONLY those.
     * - If zero records exist -> return the class_fee_schedule template.
     */
    async getStudentSchedule(
        studentId: number,
        academicYear: string,
        classId?: number,
        campusId?: number,
    ) {
        // 1. Check for saved fees
        const savedFees = await this.prisma.student_fees.findMany({
            where: {
                student_id: studentId,
                academic_year: academicYear,
            },
            include: {
                fee_types: true,
                discount_presets: true,
                student_fee_bundles: {
                    include: {
                        student_fees: {
                            select: { installment_id: true }
                        }
                    }
                },
                student_fee_installments: {
                    include: { fee_types: true }
                },
                voucher_heads: {
                    select: { id: true },
                    take: 1,
                },
            } as any,
            orderBy: {
                fee_types: {
                    priority_order: 'asc',
                },
            },
        });

        if (savedFees.length > 0) {
            return {
                fees: savedFees,
                is_template: false,
            };
        }

        // 2. No fees saved -> pull the template
        let effectiveClassId = classId;
        let effectiveCampusId = campusId;

        if (!effectiveClassId) {
            const student = await this.prisma.students.findUnique({
                where: { cc: studentId },
                select: { class_id: true, graduated_from_class_id: true, campus_id: true }
            });
            if (student) {
                effectiveClassId = student.class_id ?? student.graduated_from_class_id ?? undefined;
                if (effectiveCampusId === undefined) effectiveCampusId = student.campus_id ?? undefined;
            }
        }

        if (!effectiveClassId) {
            const resolved = await this.studentsService.resolveClassIdForStudent(studentId, classId);
            if (resolved) {
                effectiveClassId = resolved;
            }
        }

        if (!effectiveClassId) {
            return {
                fees: [],
                is_template: true,
            };
        }

        const template = await this.prisma.class_fee_schedule.findMany({
            where: {
                class_id: effectiveClassId,
                academic_year: academicYear,
                ...(effectiveCampusId !== undefined
                    ? {
                        OR: [{ campus_id: effectiveCampusId }, { campus_id: null }],
                    }
                    : {}),
            },
            include: {
                fee_types: true,
            },
            orderBy: {
                fee_types: {
                    priority_order: 'asc',
                },
            },
        });

        return {
            fees: template,
            is_template: true,
        };
    }


    async bulkSave(dto: BulkSaveStudentFeesDto, changedBy?: string) {
        const { student_id, items, bundles } = dto;

        if (items.length === 0 && !dto.academic_year) {
            return this.findByStudent(student_id);
        }

        const student = await this.prisma.students.findUnique({
            where: { cc: student_id },
        });
        if (!student) {
            throw new NotFoundException(`Student with ID ${student_id} not found`);
        }

        // Term stamped on newly created heads. Taken from the student's current
        // class, which is the same class the client used to compute each row's
        // fee_date, so the two always agree. Only ever set on create: re-stamping
        // on update would rewrite the term of a head created before the student
        // moved between term systems, which is exactly the history this column
        // exists to preserve.
        const classTerms = await getClassTermMap(this.prisma);
        const termStartMonth = termStartMonthForClass(student.class_id, classTerms);

        // Get the unique years involved in this save
        const years = Array.from(new Set(items.map((i) => i.academic_year)));
        if (items.length === 0 && dto.academic_year) {
            years.push(dto.academic_year);
        }

        if (years.length === 0) {
            return this.findByStudent(student_id);
        }

        // Side-effect audit events collected during the transaction and flushed
        // after it commits — nothing is logged for work that ends up rolled back.
        const auditEvents: FeeAuditEvent[] = [];

        const result = await this.prisma.$transaction(
            async (tx) => {
                const existingFees = await tx.student_fees.findMany({
                    where: {
                        student_id,
                        academic_year: { in: years },
                        is_discount: false,
                    },
                    include: {
                        voucher_heads: { select: { id: true }, take: 1 },
                    },
                });

                // Fee-type descriptions for readable audit notes (e.g. "Tuition Fee"
                // instead of "fee type #4").
                const feeTypeIds = Array.from(new Set([
                    ...existingFees.map((f) => f.fee_type_id).filter((v): v is number => v != null),
                    ...items.map((i) => i.fee_type_id).filter((v): v is number => v != null),
                ]));
                const feeTypesMap = new Map<number, string>();
                if (feeTypeIds.length > 0) {
                    const types = await tx.fee_types.findMany({
                        where: { id: { in: feeTypeIds } },
                        select: { id: true, description: true },
                    });
                    types.forEach((t) => feeTypesMap.set(t.id, t.description));
                }
                const feeTypeLabel = (id: number | null | undefined) =>
                    id != null ? (feeTypesMap.get(id) ?? `fee type #${id}`) : 'fee';

                // ── 1. Resolve every incoming item to the row it refers to ──
                // A row's identity is its id. `id` is absent only for rows the
                // user has just added in the grid, so the composite key below
                // survives purely as a fallback for those.
                //
                // This matters most for fee_date edits. With the composite key
                // alone, moving a row is indistinguishable from "old row gone,
                // new row added": the head gets recreated, silently dropping
                // description_prefix / split_pair_id / bundle_id / amount_paid,
                // and when the stale row can't be deleted (voucher- or
                // installment-linked, or its key still claimed by its split
                // twin — PARTIAL and BALANCE halves differ only by
                // description_prefix, which the key does not include) the row
                // is duplicated outright instead of moved.
                const existingById = new Map(existingFees.map((f) => [f.id, f]));

                const itemTargetMonth = (i: SaveStudentFeeItemDto) => {
                    const tm = i.target_month ?? i.month ?? 8;
                    return tm > 0 ? tm : 8;
                };
                // The client derives a row's editable amount with `||` over this
                // exact chain, so the guard below must too — with `??`, a stored
                // amount_after_discount of 0 alongside a non-zero amount would
                // read as an edit on a row the user never touched.
                const rowAmountOf = (f: { amount_after_discount: Prisma.Decimal | null; amount: Prisma.Decimal | null; amount_before_discount: Prisma.Decimal | null }) =>
                    Number(
                        f.amount_after_discount?.toString()
                        || f.amount?.toString()
                        || f.amount_before_discount?.toString()
                        || '0',
                    );
                const dateKeyOf = (d: Date | string | null | undefined) =>
                    !d ? 'no-date' : d instanceof Date ? d.toISOString().split('T')[0] : d;
                const compositeKeyOf = (
                    feeTypeId: number | null | undefined,
                    targetMonth: number | null | undefined,
                    academicYear: string | null | undefined,
                    feeDate: Date | string | null | undefined,
                ) => `${feeTypeId}|${targetMonth ?? 8}|${academicYear}|${dateKeyOf(feeDate)}`;

                // Pass A — an item that names an existing row owns it outright.
                // `existingFees` is already scoped to this student, these years
                // and is_discount=false, so failing to find the id here doubles
                // as the ownership check: a stale or foreign id claims nothing
                // and falls through to the fallback below.
                const resolvedRowId = new Map<SaveStudentFeeItemDto, number | null>();
                const consumedIds = new Set<number>();
                for (const item of items) {
                    if (item.id != null && existingById.has(item.id) && !consumedIds.has(item.id)) {
                        resolvedRowId.set(item, item.id);
                        consumedIds.add(item.id);
                    }
                }

                // Pass B — everything else falls back to the composite key, and
                // may only match rows no id has claimed. Candidates are queued
                // per key so two items with a colliding key take two different
                // rows rather than both grabbing (and concurrently overwriting)
                // the same one.
                const feeKeyMap = new Map<string, number[]>();
                existingFees.forEach((f) => {
                    if (consumedIds.has(f.id)) return;
                    const key = compositeKeyOf(f.fee_type_id, f.target_month ?? f.month, f.academic_year, f.fee_date);
                    const queue = feeKeyMap.get(key);
                    if (queue) queue.push(f.id);
                    else feeKeyMap.set(key, [f.id]);
                });
                for (const item of items) {
                    if (resolvedRowId.has(item)) continue;
                    const key = compositeKeyOf(item.fee_type_id, itemTargetMonth(item), item.academic_year, item.fee_date);
                    const matchId = feeKeyMap.get(key)?.shift();
                    if (matchId != null) {
                        resolvedRowId.set(item, matchId);
                        consumedIds.add(matchId);
                    } else {
                        resolvedRowId.set(item, null);
                    }
                }

                // A head that still carries voucher heads is owned by its
                // voucher, not by this grid. Deleting the voucher cascades the
                // heads away (voucher_heads.vouchers is onDelete: Cascade), and
                // the row is then freely editable again — this only rejects
                // edits made while the voucher is still live, and is the
                // backstop for the frontend's isRowLocked, which keys off
                // status alone and so misses a voucher-linked row in any other
                // status. Values are compared, never mere presence: the grid
                // re-sends every row on every save, so an untouched locked row
                // must still save cleanly.
                const lockedViolations: string[] = [];
                for (const item of items) {
                    const rowId = resolvedRowId.get(item);
                    if (rowId == null) continue;
                    const before = existingById.get(rowId);
                    if (!before || before.voucher_heads.length === 0) continue;

                    const changed = [
                        before.fee_type_id !== item.fee_type_id ? 'fee type' : null,
                        (before.target_month ?? before.month ?? 8) !== itemTargetMonth(item) ? 'month' : null,
                        dateKeyOf(before.fee_date) !== dateKeyOf(item.fee_date) ? 'fee date' : null,
                        rowAmountOf(before) !== Number(item.amount ?? item.amount_before_discount ?? 0) ? 'amount' : null,
                        Number(before.scholarship_percentage ?? 0)
                            !== Number(item.scholarship_percentage ?? 0) ? 'scholarship' : null,
                    ].filter(Boolean);

                    if (changed.length > 0) {
                        lockedViolations.push(
                            `${feeTypeLabel(before.fee_type_id)} (${this.periodLabel(before.target_month, before.academic_year, before.fee_date)}) — ${changed.join(', ')}`,
                        );
                    }
                }
                if (lockedViolations.length > 0) {
                    throw new BadRequestException(
                        `Cannot change ${lockedViolations.length} fee row(s) that still have an issued voucher. ` +
                        `Delete or cancel the voucher first: ${lockedViolations.join('; ')}.`,
                    );
                }

                // 2. Delete the rows no incoming item claimed — i.e. the ones the
                // user actually removed from the grid. Keying this off the claims
                // rather than off the composite key is also what makes a grid
                // delete reliable: a removed row whose key happened to be shared
                // with a surviving row (a split pair) used to be spared.
                // Installment-linked rows are excluded: they're managed exclusively through the
                // installments module's own CRUD (create/update/removeHead), and standalone-mode
                // installment heads are never part of the studentwise-fees grid's payload in the
                // first place, so treating their absence as "removed by the user" would wipe out
                // installment plans every time the unrelated bulk-save endpoint is called.
                const toDeleteRows = existingFees
                    .filter((f) => f.installment_id == null)
                    .filter((f) => !consumedIds.has(f.id))
                    .filter((f) => f.voucher_heads.length === 0);

                const toDelete = toDeleteRows.map((f) => f.id);

                if (toDelete.length > 0) {
                    await tx.student_fees.deleteMany({
                        where: { id: { in: toDelete } },
                    });

                    auditEvents.push({
                        entity_type: 'STUDENT_FEE_SCHEDULE',
                        entity_id: toDelete.join(','),
                        action: 'DELETED',
                        note: `Removed ${toDelete.length} fee row(s) from student #${student_id}'s schedule (no longer in the submitted list): ` +
                            toDeleteRows.map((f) => `${feeTypeLabel(f.fee_type_id)} (${this.periodLabel(f.target_month, f.academic_year, f.fee_date)}, ${this.fmtMoney(f.amount)})`).join(', '),
                    });
                }

                // 3. Upsert items
                const createdLabels: string[] = [];
                const updatedLabels: string[] = [];
                const upsertPromises = items.map(async (item) => {
                    const targetMonth = itemTargetMonth(item);
                    const feeDate = item.fee_date ? new Date(item.fee_date) : null;

                    // Resolved synchronously above, before anything was deleted.
                    const existingId = resolvedRowId.get(item) ?? undefined;

                    // Scholarships are MTF-only (fee_type_id=1). Enforced here — the
                    // single source of truth — regardless of what the frontend sends.
                    const hasScholarship = item.scholarship_percentage != null;
                    if (hasScholarship && item.fee_type_id !== 1) {
                        throw new BadRequestException(
                            `Scholarships can only be applied to MTF (fee_type_id=1); got fee_type_id=${item.fee_type_id}.`,
                        );
                    }

                    // Resolve/create the scholarship preset (same pattern as createDiscount).
                    let scholarshipTypeId: number | null = null;
                    if (hasScholarship) {
                        if (item.scholarship_type_id != null) {
                            const preset = await tx.scholarship_presets.findUnique({ where: { id: item.scholarship_type_id } });
                            if (!preset) throw new NotFoundException(`Scholarship preset #${item.scholarship_type_id} not found`);
                            scholarshipTypeId = preset.id;
                        } else if (item.scholarship_custom_title?.trim()) {
                            const newPreset = await tx.scholarship_presets.create({
                                data: { title: item.scholarship_custom_title.trim().toUpperCase(), is_active: true },
                            });
                            scholarshipTypeId = newPreset.id;
                        }
                    }

                    // amount_after_discount = the amount after the system discount, before scholarship
                    // (what `item.amount` has always meant from the client's perspective).
                    // `amount` is the SINGLE SOURCE OF TRUTH for receivables and is always a
                    // whole number — see the trg_student_fees_amount_invariants DB trigger,
                    // which enforces both rules regardless of which code path writes.
                    const amountAfterDiscount = new Prisma.Decimal(item.amount ?? item.amount_before_discount ?? 0);
                    const finalAmount = (hasScholarship
                        ? amountAfterDiscount
                              .mul(new Prisma.Decimal(1).minus(new Prisma.Decimal(item.scholarship_percentage!).div(100)))
                        : amountAfterDiscount
                    ).toDecimalPlaces(0);

                    if (existingId) {
                        const before = existingById.get(existingId);
                        const beforeAmountAfterDiscount = before ? Number(before.amount_after_discount ?? before.amount ?? 0) : null;
                        const amountChanged = before && beforeAmountAfterDiscount !== Number(amountAfterDiscount);
                        const scholarshipChanged = before &&
                            Number(before.scholarship_percentage ?? 0) !== Number(item.scholarship_percentage ?? 0);
                        const beforeDateStr = before?.fee_date ? before.fee_date.toISOString().split('T')[0] : null;
                        const afterDateStr = feeDate ? feeDate.toISOString().split('T')[0] : null;
                        const dateChanged = before && beforeDateStr !== afterDateStr;
                        if (before && (amountChanged || dateChanged || scholarshipChanged)) {
                            updatedLabels.push(
                                `${feeTypeLabel(item.fee_type_id)} (${this.periodLabel(targetMonth, item.academic_year, feeDate)}): ` +
                                [
                                    amountChanged ? `amount ${this.fmtMoney(before.amount)} → ${this.fmtMoney(finalAmount)}` : null,
                                    scholarshipChanged ? `scholarship ${before.scholarship_percentage ?? 0}% → ${item.scholarship_percentage ?? 0}%` : null,
                                    dateChanged ? `date ${this.fmtDate(before.fee_date)} → ${this.fmtDate(feeDate)}` : null,
                                ].filter(Boolean).join(', '),
                            );
                        }
                        return tx.student_fees.update({
                            where: { id: existingId },
                            data: {
                                month: item.month,
                                amount: finalAmount,
                                amount_before_discount: item.amount_before_discount,
                                amount_after_discount: amountAfterDiscount,
                                scholarship_percentage: item.scholarship_percentage ?? null,
                                scholarship_type_id: scholarshipTypeId,
                                academic_year: item.academic_year,
                                target_month: targetMonth,
                                fee_date: feeDate,
                            },
                        });
                    }

                    createdLabels.push(`${feeTypeLabel(item.fee_type_id)} (${this.periodLabel(targetMonth, item.academic_year, feeDate)}, ${this.fmtMoney(finalAmount)})`);
                    return tx.student_fees.create({
                        data: {
                            student_id,
                            fee_type_id: item.fee_type_id,
                            month: item.month,
                            amount: finalAmount,
                            amount_before_discount: item.amount_before_discount,
                            amount_after_discount: amountAfterDiscount,
                            scholarship_percentage: item.scholarship_percentage ?? null,
                            scholarship_type_id: scholarshipTypeId,
                            academic_year: item.academic_year,
                            target_month: targetMonth,
                            term_start_month: termStartMonth,
                            fee_date: feeDate,
                            status: 'NOT_ISSUED',
                        },
                    });
                });
                await Promise.all(upsertPromises);

                if (createdLabels.length > 0) {
                    auditEvents.push({
                        entity_type: 'STUDENT_FEE_SCHEDULE',
                        entity_id: String(student_id),
                        action: 'CREATED',
                        note: `Added ${createdLabels.length} fee row(s) to student #${student_id}'s schedule: ${createdLabels.join('; ')}.`,
                    });
                }
                if (updatedLabels.length > 0) {
                    auditEvents.push({
                        entity_type: 'STUDENT_FEE_SCHEDULE',
                        entity_id: String(student_id),
                        action: 'UPDATED',
                        note: `Updated ${updatedLabels.length} existing fee row(s) on student #${student_id}'s schedule: ${updatedLabels.join('; ')}.`,
                    });
                }

                // 4. Process Bundles if provided
                if (bundles && bundles.length > 0) {
                    // Refetch all current fees for this student/years to get accurate IDs and current state
                    const allFees = await tx.student_fees.findMany({
                        where: {
                            student_id,
                            academic_year: { in: years },
                        },
                    });

                    for (const b of bundles) {
                        const bundleFees = allFees.filter((f) => {
                            const dateStr = f.fee_date ? f.fee_date.toISOString().split('T')[0] : 'no-date';
                            const key = `${f.fee_type_id}|${f.target_month}|${dateStr}`;
                            return b.fee_keys.includes(key);
                        });

                        if (bundleFees.length > 0) {
                            const firstFee = bundleFees[0];
                            const bundleMonth = b.target_month ?? firstFee.target_month;

                            const calculatedTotal = bundleFees.reduce(
                                (sum, f) =>
                                    sum.add(
                                        new Prisma.Decimal(
                                            f.amount ||
                                            f.amount_before_discount ||
                                            0,
                                        ),
                                    ),
                                new Prisma.Decimal(0),
                            );

                            const bundle = await tx.student_fee_bundles.create({
                                data: {
                                    student_id,
                                    bundle_name: b.bundle_name,
                                    total_amount: calculatedTotal,
                                    academic_year: b.academic_year,
                                    target_month: bundleMonth,
                                },
                            });

                            await tx.student_fees.updateMany({
                                where: {
                                    id: { in: bundleFees.map((f) => f.id) },
                                },
                                data: {
                                    bundle_id: bundle.id,
                                },
                            });

                            auditEvents.push({
                                entity_type: 'STUDENT_FEE_SCHEDULE',
                                entity_id: String(bundle.id),
                                action: 'CREATED',
                                note: `Bundle "${b.bundle_name}" created for student #${student_id}: grouped ${bundleFees.length} fee row(s), total ${this.fmtMoney(calculatedTotal)}.`,
                            });
                        }
                    }
                }

                // 5. Cleanup & Sync Existing Bundles
                // Recalculate totals for all bundles involved or existing in these years
                const refreshedFees = await tx.student_fees.findMany({
                    where: { student_id, academic_year: { in: years } },
                    select: { bundle_id: true, amount: true, amount_before_discount: true },
                });

                const affectedBundleIds = new Set<number>();
                refreshedFees.forEach(f => { if (f.bundle_id) affectedBundleIds.add(f.bundle_id); });

                // Also find bundles that might now be empty for these years
                const existingBundles = await tx.student_fee_bundles.findMany({
                    where: { student_id, academic_year: { in: years } },
                    select: { id: true },
                });
                existingBundles.forEach(b => affectedBundleIds.add(b.id));

                for (const bId of Array.from(affectedBundleIds)) {
                    const members = refreshedFees.filter(f => f.bundle_id === bId);
                    if (members.length === 0) {
                        await tx.student_fee_bundles.delete({ where: { id: bId } });
                        auditEvents.push({
                            entity_type: 'STUDENT_FEE_SCHEDULE',
                            entity_id: String(bId),
                            action: 'DELETED',
                            note: `Bundle #${bId} deleted — all its member fee rows were removed from student #${student_id}'s schedule.`,
                        });
                    } else {
                        const syncTotal = members.reduce(
                            (sum, f) => sum.add(new Prisma.Decimal(f.amount || f.amount_before_discount || 0)),
                            new Prisma.Decimal(0),
                        );
                        await tx.student_fee_bundles.update({
                            where: { id: bId },
                            data: { total_amount: syncTotal },
                        });
                        auditEvents.push({
                            entity_type: 'STUDENT_FEE_SCHEDULE',
                            entity_id: String(bId),
                            action: 'UPDATED',
                            field: 'total_amount',
                            new_value: syncTotal.toString(),
                            note: `Bundle #${bId} total recalculated to ${this.fmtMoney(syncTotal)} for student #${student_id} after its member fees changed.`,
                        });
                    }
                }

                // Return final state after all operations
                return tx.student_fees.findMany({
                    where: { student_id },
                    include: {
                        fee_types: true,
                        student_fee_bundles: true,
                    },
                    orderBy: {
                        fee_types: {
                            priority_order: 'asc',
                        },
                    },
                });
            },
            {
                maxWait: 10000,
                timeout: 30000,
            },
        ).catch((err) => {
            throw this.translateDuplicateHead(err);
        });
        // Overall summary entry, followed by every granular event (rows deleted,
        // created, updated, installment plans and bundles touched) collected above.
        auditEvents.unshift({
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: String(student_id),
            action: 'UPDATED',
            note: `Bulk save completed for student #${student_id}: ${items.length} row(s) submitted.`,
        });
        await this.flushAuditEvents(auditEvents, student_id, changedBy ?? 'system');
        return result;
    }

    /**
     * Turn the student_fees_unique_regular_head violation into something a user
     * can act on. That partial index is (student_id, fee_type_id, fee_date) over
     * non-discount, non-split rows, so it fires when a head is moved onto a date
     * this student already has the same fee type on — coarser than the grid's own
     * notion of a duplicate (it ignores target_month), which is why this surfaces
     * on legitimate-looking edits. Anything else is rethrown untouched.
     */
    private translateDuplicateHead(err: unknown): unknown {
        if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002' &&
            String((err.meta as any)?.target ?? '').includes('student_fees_unique_regular_head')
        ) {
            return new ConflictException(
                'This student already has a fee head of that type on that date. ' +
                'Pick a different fee date, or edit the existing head instead of adding a second one.',
            );
        }
        return err;
    }

    /**
     * Explicitly update the fee_date for one or more student_fees records.
     * Called before bundle creation to persist any date changes the user made in the UI.
     */
    async updateFeeDates(updates: { id: number; fee_date: string }[], changedBy: string = 'system') {
        if (updates.length === 0) return [];

        const before = await this.prisma.student_fees.findMany({
            where: { id: { in: updates.map((u) => u.id) } },
            select: { id: true, fee_date: true, student_id: true },
        });
        const beforeById = new Map(before.map((f) => [f.id, f]));

        const result = await this.prisma.$transaction(
            updates.map(({ id, fee_date }) =>
                this.prisma.student_fees.update({
                    where: { id },
                    data: { fee_date: new Date(fee_date) },
                }),
            ),
        );

        const changedNotes: string[] = [];
        for (const { id, fee_date } of updates) {
            const b = beforeById.get(id);
            if (!b) continue;
            const beforeStr = b.fee_date ? b.fee_date.toISOString().split('T')[0] : null;
            if (beforeStr === fee_date) continue;
            changedNotes.push(`fee #${id}: ${this.fmtDate(b.fee_date)} → ${this.fmtDate(fee_date)}`);
        }

        if (changedNotes.length > 0) {
            const distinctStudents = new Set(before.map((f) => f.student_id));
            await this.auditLogs.log({
                entity_type: 'STUDENT_FEE_SCHEDULE',
                entity_id: updates.map((u) => u.id).join(','),
                action: 'UPDATED',
                field: 'fee_date',
                changed_by: changedBy,
                student_id: distinctStudents.size === 1 ? [...distinctStudents][0] : null,
                note: `Updated fee_date for ${changedNotes.length} fee row(s): ${changedNotes.join('; ')}.`,
            });
        }

        return result;
    }

    async createBundle(dto: CreateBundleDto, changedBy: string = 'system') {
        const { student_id, bundle_name, total_amount, academic_year, fee_ids, target_month, fee_date_overrides } = dto;

        // Build a lookup: fee_id → new fee_date (for fees that had their date changed in the UI)
        const dateOverrideMap = new Map<number, Date>(
            (fee_date_overrides ?? []).map(({ id, fee_date }) => [id, new Date(fee_date)])
        );

        // Verify all fees belong to this student
        const fees = await this.prisma.student_fees.findMany({
            where: { id: { in: fee_ids }, student_id },
        });

        if (fees.length !== fee_ids.length) {
            throw new BadRequestException('One or more fees do not belong to the student');
        }

        const bundle = await this.prisma.$transaction(async (tx) => {
            const feesForProcessing = await tx.student_fees.findMany({
                where: { id: { in: fee_ids } },
                select: { amount: true, amount_before_discount: true, month: true, target_month: true },
            });

            const calculatedTotal = feesForProcessing.reduce(
                (sum, f) => sum.add(new Prisma.Decimal(f.amount || f.amount_before_discount || 0)),
                new Prisma.Decimal(0),
            );

            const firstFee = feesForProcessing[0];
            const finalTargetMonth = target_month ?? firstFee.month ?? firstFee.target_month;

            // Create the bundle record
            const bundle = await tx.student_fee_bundles.create({
                data: {
                    student_id,
                    bundle_name,
                    total_amount: total_amount ? new Prisma.Decimal(total_amount) : calculatedTotal,
                    academic_year,
                    target_month: finalTargetMonth,
                },
            });

            // Link each fee to the bundle, applying date overrides atomically
            for (const feeId of fee_ids) {
                await tx.student_fees.update({
                    where: { id: feeId },
                    data: {
                        bundle_id: bundle.id,
                        ...(dateOverrideMap.has(feeId) ? { fee_date: dateOverrideMap.get(feeId) } : {}),
                    },
                });
            }

            return bundle;
        });

        await this.auditLogs.log({
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: String(bundle.id),
            action: 'CREATED',
            changed_by: changedBy,
            student_id,
            note: `Bundle "${bundle_name}" created for student #${student_id}: grouped ${fee_ids.length} fee row(s), total ${this.fmtMoney(bundle.total_amount)}${dateOverrideMap.size > 0 ? `, ${dateOverrideMap.size} fee date(s) overridden` : ''}.`,
        });

        return bundle;
    }

    async updateBundle(id: number, dto: Partial<CreateBundleDto>, changedBy: string = 'system') {
        const { bundle_name, total_amount, academic_year, fee_ids, target_month, fee_date_overrides } = dto;

        const before = await this.prisma.student_fee_bundles.findUnique({ where: { id } });
        if (!before) {
            throw new NotFoundException(`Bundle #${id} not found`);
        }

        const dateOverrideMap = new Map<number, Date>(
            (fee_date_overrides ?? []).map(({ id: fid, fee_date }) => [fid, new Date(fee_date)])
        );

        const bundle = await this.prisma.$transaction(async (tx) => {
            const bundle = await tx.student_fee_bundles.update({
                where: { id },
                data: {
                    bundle_name,
                    total_amount: total_amount ? new Prisma.Decimal(total_amount) : undefined,
                    academic_year,
                    target_month
                },
            });

            if (fee_ids || target_month !== undefined) {
                // 1. Revert fees currently in this bundle to their original target_month
                await tx.$executeRaw`
                    UPDATE public.student_fees
                    SET month = target_month
                    WHERE bundle_id = ${id}
                `;

                // 2. Clear old links
                if (fee_ids) {
                    await tx.student_fees.updateMany({
                        where: { bundle_id: id },
                        data: { bundle_id: null },
                    });
                }

                // 3. Link and apply date overrides
                const finalFeeIds = fee_ids || (await tx.student_fees.findMany({ where: { bundle_id: id }, select: { id: true } })).map(f => f.id);

                for (const feeId of finalFeeIds) {
                    await tx.student_fees.update({
                        where: { id: feeId },
                        data: {
                            bundle_id: id,
                            ...(dateOverrideMap.has(feeId) ? { fee_date: dateOverrideMap.get(feeId) } : {}),
                        },
                    });
                }
            }

            return bundle;
        });

        const fieldChanges: string[] = [];
        if (bundle_name !== undefined && bundle_name !== before.bundle_name) {
            fieldChanges.push(`name "${before.bundle_name}" → "${bundle_name}"`);
        }
        if (total_amount !== undefined && Number(before.total_amount) !== Number(total_amount)) {
            fieldChanges.push(`total ${this.fmtMoney(before.total_amount)} → ${this.fmtMoney(total_amount)}`);
        }
        if (academic_year !== undefined && academic_year !== before.academic_year) {
            fieldChanges.push(`AY ${before.academic_year} → ${academic_year}`);
        }
        if (target_month !== undefined && target_month !== before.target_month) {
            fieldChanges.push(`target month ${before.target_month} → ${target_month}`);
        }
        if (fee_ids) {
            fieldChanges.push(`re-linked to ${fee_ids.length} fee row(s)${dateOverrideMap.size > 0 ? ` (${dateOverrideMap.size} date override(s))` : ''}`);
        }

        await this.auditLogs.log({
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: String(id),
            action: 'UPDATED',
            changed_by: changedBy,
            student_id: before.student_id,
            note: fieldChanges.length > 0
                ? `Bundle #${id} ("${before.bundle_name}") updated: ${fieldChanges.join(', ')}.`
                : `Bundle #${id} ("${before.bundle_name}") update submitted with no effective changes.`,
        });

        return bundle;
    }

    async deleteBundle(id: number, changedBy: string = 'system') {
        const before = await this.prisma.student_fee_bundles.findUnique({
            where: { id },
            include: { student_fees: { select: { id: true } } },
        });
        if (!before) {
            throw new NotFoundException(`Bundle #${id} not found`);
        }

        await this.prisma.$transaction(async (tx) => {
            // Revert member fees' month to their target_month (original period)
            await tx.$executeRaw`
                UPDATE public.student_fees
                SET month = target_month
                WHERE bundle_id = ${id}
            `;

            return tx.student_fee_bundles.delete({
                where: { id },
            });
        });

        await this.auditLogs.log({
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: String(id),
            action: 'DELETED',
            changed_by: changedBy,
            student_id: before.student_id,
            note: `Bundle #${id} ("${before.bundle_name}") deleted — its ${before.student_fees.length} member fee row(s) reverted to their original target month; bundle total was ${this.fmtMoney(before.total_amount)}.`,
        });
    }

    async getBundlesByStudent(studentId: number) {
        return this.prisma.student_fee_bundles.findMany({
            where: { student_id: studentId },
            include: {
                student_fees: {
                    include: { fee_types: true },
                },
            },
        });
    }

    // ─── Bulk Operations Helpers ──────────────────────────────────────────────

    private async getStudentsInScope(campusId: number, classId?: number, sectionId?: number) {
        return this.prisma.students.findMany({
            where: {
                campus_id: campusId,
                ...(classId ? { class_id: classId } : {}),
                ...(sectionId ? { section_id: sectionId } : {}),
                deleted_at: null,
                status: { in: ['ENROLLED', 'SOFT_ADMISSION'] },
            },
            select: {
                cc: true,
                full_name: true,
                gr_number: true,
                classes: { select: { description: true, class_code: true } },
                sections: { select: { description: true } },
            },
        });
    }

    /**
     * Calendar year of `month` within `academicYear`, for building a fee_date.
     *
     * Takes the class term map explicitly rather than reading a cached field:
     * the result depends on it, so an implicit "somebody loaded this earlier in
     * the request" contract would silently return a different date depending on
     * call order. Omitting it falls back to the legacy special-class list.
     */
    private getCalendarYear(
        academicYear: string,
        month: number,
        classId?: number,
        classTerms?: ReadonlyMap<number, number>,
    ): number {
        const startYear = parseInt(academicYear.split('-')[0]);
        const cutoff = resolveTermStartMonth({ classId, classTerms });
        return month >= cutoff ? startYear : startYear + 1;
    }

    /**
     * student_id -> term_start_month of the student's current class, for stamping
     * newly created heads. Bulk paths span many students across many classes, so
     * this resolves them in one query rather than per row.
     */
    private async resolveTermsForStudents(
        studentIds: number[],
    ): Promise<{ termByStudent: Map<number, number>; classTerms: ReadonlyMap<number, number> }> {
        const classTerms = await getClassTermMap(this.prisma);
        const students = await this.prisma.students.findMany({
            where: { cc: { in: studentIds } },
            select: { cc: true, class_id: true },
        });
        return {
            classTerms,
            termByStudent: new Map(
                students.map((s) => [s.cc, termStartMonthForClass(s.class_id, classTerms)]),
            ),
        };
    }

    private isValidDayForMonth(year: number, month: number, day: number): boolean {
        const d = new Date(year, month - 1, day);
        return d.getMonth() === month - 1;
    }

    // ─── Tab 1: Preview ───────────────────────────────────────────────────────

    async bulkPreview(params: {
        campus_id: number;
        class_id?: number;
        section_id?: number;
        academic_year: string;
        fee_type_id: number;
        fee_date: string;
    }) {
        const { campus_id, class_id, section_id, academic_year, fee_type_id, fee_date } = params;
        const students = await this.getStudentsInScope(campus_id, class_id, section_id);

        if (students.length === 0) {
            return { students: [], total: 0, will_add: 0, already_exists: 0 };
        }

        const studentIds = students.map(s => s.cc);
        const targetDate = new Date(fee_date);

        const existing = await this.prisma.student_fees.findMany({
            where: { student_id: { in: studentIds }, fee_type_id, fee_date: targetDate, academic_year },
            select: { student_id: true },
        });

        const existingSet = new Set(existing.map(e => e.student_id));

        const result = students.map(s => ({
            student_id: s.cc,
            full_name: s.full_name,
            gr_number: s.gr_number,
            class: (s as any).classes?.description || '',
            section: (s as any).sections?.description || '',
            status: existingSet.has(s.cc) ? 'already_exists' : 'will_add',
        }));

        return {
            students: result,
            total: result.length,
            will_add: result.filter(r => r.status === 'will_add').length,
            already_exists: result.filter(r => r.status === 'already_exists').length,
        };
    }

    // ─── Tab 1: Confirm ───────────────────────────────────────────────────────

    async bulkAdd(dto: import('./dto/bulk-add.dto').BulkAddDto, changedBy: string = 'system') {
        const { academic_year, fee_type_id, month, fee_date, amount, student_ids } = dto;
        const targetDate = new Date(fee_date);
        const { termByStudent } = await this.resolveTermsForStudents(student_ids);

        // Use a single createMany with skipDuplicates instead of N parallel transactions.
        // Opening one transaction per student in parallel exhausts the connection pool.
        const result = await this.prisma.student_fees.createMany({
            data: student_ids.map(studentId => ({
                student_id: studentId,
                fee_type_id,
                month,
                target_month: month,
                term_start_month: termByStudent.get(studentId) ?? DEFAULT_TERM_START_MONTH,
                academic_year,
                amount: new Prisma.Decimal(amount),
                amount_before_discount: new Prisma.Decimal(amount),
                amount_after_discount: new Prisma.Decimal(amount),
                fee_date: targetDate,
                status: 'NOT_ISSUED' as any,
            })),
            skipDuplicates: true,
        });

        const added = result.count;
        const skipped = student_ids.length - added;

        await this.auditLogs.log({
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: `bulk-add:${fee_type_id}:${fee_date}`,
            action: 'CREATED',
            section: 'finance',
            changed_by: changedBy,
            note: `Bulk-added fee (type #${fee_type_id}, ${academic_year}, due ${this.fmtDate(targetDate)}, ${this.fmtMoney(amount)}) targeting ${student_ids.length} student(s): ${added} row(s) created, ${skipped} already existed and were skipped.`,
        });

        return { added, skipped, skipped_reasons: [] };
    }

    // ─── Tab 2: Conflict Check ────────────────────────────────────────────────

    async bulkAddRangeConflicts(params: {
        campus_id: number;
        class_id?: number;
        section_id?: number;
        academic_year: string;
        fee_type_id: number;
        start_month: number;
        end_month: number;
        day: number;
    }) {
        const { campus_id, class_id, section_id, academic_year, fee_type_id, start_month, end_month, day } = params;
        const students = await this.getStudentsInScope(campus_id, class_id, section_id);
        const studentIds = students.map(s => s.cc);

        const ACADEMIC_ORDER = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];
        const startIndex = ACADEMIC_ORDER.indexOf(start_month);
        const endIndex = ACADEMIC_ORDER.indexOf(end_month);

        // Build the list of valid fee dates first (no DB calls yet)
        const monthMeta: { month: number; calYear: number; feeDateStr: string; feeDate: Date; valid: boolean; reason?: string }[] = [];
        for (let i = startIndex; i <= endIndex; i++) {
            const month = ACADEMIC_ORDER[i];
            const calYear = this.getCalendarYear(academic_year, month, class_id);
            if (!this.isValidDayForMonth(calYear, month, day)) {
                monthMeta.push({ month, calYear, feeDateStr: '', feeDate: new Date(), valid: false, reason: `Day ${day} doesn't exist in this month` });
            } else {
                const feeDateStr = `${calYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                monthMeta.push({ month, calYear, feeDateStr, feeDate: new Date(feeDateStr), valid: true });
            }
        }

        // Single batched DB query instead of one query per month
        const validFeeDates = monthMeta.filter(m => m.valid).map(m => m.feeDate);
        const allExisting = studentIds.length > 0 && validFeeDates.length > 0
            ? await this.prisma.student_fees.findMany({
                where: {
                    student_id: { in: studentIds },
                    fee_type_id,
                    fee_date: { in: validFeeDates },
                    academic_year,
                },
                select: { student_id: true, fee_date: true },
            })
            : [];

        // Group results by fee_date in memory
        const existingByDate = new Map<string, number>();
        for (const row of allExisting) {
            const key = row.fee_date?.toISOString().split('T')[0] ?? '';
            existingByDate.set(key, (existingByDate.get(key) ?? 0) + 1);
        }

        const monthResults: any[] = monthMeta.map(m => {
            if (!m.valid) return { month: m.month, valid: false, reason: m.reason };
            const existingCount = existingByDate.get(m.feeDateStr) ?? 0;
            return {
                month: m.month,
                valid: true,
                fee_date: m.feeDateStr,
                total_students: studentIds.length,
                existing: existingCount,
                will_add: studentIds.length - existingCount,
            };
        });

        return { months: monthResults, total_students: studentIds.length };
    }

    // ─── Tab 2: Confirm ───────────────────────────────────────────────────────

    async bulkAddRange(dto: import('./dto/bulk-add-range.dto').BulkAddRangeDto, changedBy: string = 'system') {
        const { academic_year, fee_type_id, start_month, end_month, day, amount, student_ids } = dto;

        const monthSummary: any[] = [];
        let totalAddedNum = 0;
        let totalSkippedNum = 0;

        const { termByStudent } = await this.resolveTermsForStudents(student_ids);

        const ACADEMIC_ORDER = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];
        const startIndex = ACADEMIC_ORDER.indexOf(start_month);
        const endIndex = ACADEMIC_ORDER.indexOf(end_month);

        for (let i = startIndex; i <= endIndex; i++) {
            const month = ACADEMIC_ORDER[i];
            const calYear = this.getCalendarYear(academic_year, month);
            if (!this.isValidDayForMonth(calYear, month, day)) {
                monthSummary.push({ month, skipped_reason: 'day_invalid' });
                continue;
            }
            const feeDateStr = `${calYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const date = new Date(feeDateStr);

            // Using createMany for high-performance bulk operations (avoids timeouts on large campuses)
            const bulkData = student_ids.map(studentId => ({
                student_id: studentId,
                fee_type_id,
                month,
                target_month: month,
                term_start_month: termByStudent.get(studentId) ?? DEFAULT_TERM_START_MONTH,
                academic_year,
                amount: new Prisma.Decimal(amount),
                amount_before_discount: new Prisma.Decimal(amount),
                amount_after_discount: new Prisma.Decimal(amount),
                fee_date: date,
                status: 'NOT_ISSUED' as any,
            }));

            // Prisma createMany with skipDuplicates: true translates to INSERT IGNORE or ON CONFLICT DO NOTHING
            const result = await this.prisma.student_fees.createMany({
                data: bulkData,
                skipDuplicates: true,
            });

            const added = result.count;
            const skipped = student_ids.length - added;

            totalAddedNum += added;
            totalSkippedNum += skipped;
            monthSummary.push({ month, added, skipped });
        }

        await this.auditLogs.log({
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: `bulk-add-range:${fee_type_id}:${start_month}-${end_month}`,
            action: 'CREATED',
            section: 'finance',
            changed_by: changedBy,
            note: `Bulk-added fee (type #${fee_type_id}, ${academic_year}, ${this.fmtMoney(amount)}) across months ${start_month}–${end_month} (day ${day}) targeting ${student_ids.length} student(s): ${totalAddedNum} row(s) created, ${totalSkippedNum} skipped. Per-month: ${monthSummary.map((m) => m.skipped_reason ? `month ${m.month} invalid day` : `month ${m.month} +${m.added}/-${m.skipped}`).join(', ')}.`,
        });

        return {
            summary: monthSummary,
            total_added: totalAddedNum,
            total_skipped: totalSkippedNum,
        };
    }

    // ─── Tab 3: Delete Single Date Preview ───────────────────────────────────

    async bulkDeletePreview(params: {
        campus_id: number;
        class_id?: number;
        section_id?: number;
        academic_year: string;
        fee_date: string;
        fee_type_id?: number;
    }) {
        const { campus_id, class_id, section_id, academic_year, fee_date, fee_type_id } = params;
        const students = await this.getStudentsInScope(campus_id, class_id, section_id);

        if (students.length === 0) return { rows: [], total: 0, can_delete: 0, blocked: 0 };

        const studentIds = students.map(s => s.cc);
        const targetDate = new Date(fee_date);

        const fees = await this.prisma.student_fees.findMany({
            where: {
                student_id: { in: studentIds },
                academic_year,
                fee_date: targetDate,
                ...(fee_type_id ? { fee_type_id } : {}),
            },
            include: {
                fee_types: { select: { description: true } },
                students: {
                    select: {
                        full_name: true, gr_number: true,
                        classes: { select: { description: true } },
                        sections: { select: { description: true } },
                    },
                },
                voucher_heads: { select: { id: true }, take: 1 },
            },
        });

        const rows = fees.map(f => ({
            id: f.id,
            student_id: f.student_id,
            student_name: (f as any).students.full_name,
            gr_number: (f as any).students.gr_number,
            class: (f as any).students.classes?.description || '',
            section: (f as any).students.sections?.description || '',
            fee_type: (f as any).fee_types.description,
            amount: f.amount?.toString() || '0',
            fee_date: f.fee_date?.toISOString().split('T')[0] || '',
            has_voucher: (f as any).voucher_heads.length > 0,
            status: (f as any).voucher_heads.length > 0 ? 'blocked' : 'can_delete',
        }));

        return {
            rows,
            total: rows.length,
            can_delete: rows.filter(r => !r.has_voucher).length,
            blocked: rows.filter(r => r.has_voucher).length,
        };
    }

    // ─── Tab 4: Delete Date Range Preview ────────────────────────────────────

    async bulkDeleteRangePreview(params: {
        campus_id: number;
        class_id?: number;
        section_id?: number;
        academic_year: string;
        start_month: number;
        end_month: number;
        day: number;
        fee_type_id?: number;
    }) {
        const { campus_id, class_id, section_id, academic_year, start_month, end_month, day, fee_type_id } = params;
        const students = await this.getStudentsInScope(campus_id, class_id, section_id);
        const studentIds = students.map(s => s.cc);

        const ACADEMIC_ORDER = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];
        const startIndex = ACADEMIC_ORDER.indexOf(start_month);
        const endIndex = ACADEMIC_ORDER.indexOf(end_month);

        // Build month metadata without any DB calls
        const monthMeta: { month: number; feeDateStr: string; feeDate: Date; valid: boolean }[] = [];
        for (let i = startIndex; i <= endIndex; i++) {
            const month = ACADEMIC_ORDER[i];
            const calYear = this.getCalendarYear(academic_year, month, class_id);
            if (!this.isValidDayForMonth(calYear, month, day)) {
                monthMeta.push({ month, feeDateStr: '', feeDate: new Date(), valid: false });
            } else {
                const feeDateStr = `${calYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                monthMeta.push({ month, feeDateStr, feeDate: new Date(feeDateStr), valid: true });
            }
        }

        // Single batched DB query instead of one query per month
        const validFeeDates = monthMeta.filter(m => m.valid).map(m => m.feeDate);
        const allFees = studentIds.length > 0 && validFeeDates.length > 0
            ? await this.prisma.student_fees.findMany({
                where: {
                    student_id: { in: studentIds },
                    academic_year,
                    fee_date: { in: validFeeDates },
                    ...(fee_type_id ? { fee_type_id } : {}),
                },
                include: { voucher_heads: { select: { id: true }, take: 1 } },
            })
            : [];

        // Group fees by fee_date in memory
        const feesByDate = new Map<string, typeof allFees>();
        for (const fee of allFees) {
            const key = fee.fee_date?.toISOString().split('T')[0] ?? '';
            if (!feesByDate.has(key)) feesByDate.set(key, []);
            feesByDate.get(key)!.push(fee);
        }

        const allDeletableIds: number[] = [];
        const monthResults: any[] = monthMeta.map(m => {
            if (!m.valid) return { month: m.month, valid: false, reason: 'day_invalid', fee_date: null, total: 0, can_delete: 0, blocked: 0, fee_ids: [] };

            const fees = feesByDate.get(m.feeDateStr) ?? [];
            const canDelete = fees.filter((f: any) => f.voucher_heads.length === 0);
            const blocked = fees.filter((f: any) => f.voucher_heads.length > 0);
            const feeIds = canDelete.map((f: any) => f.id);
            allDeletableIds.push(...feeIds);

            return {
                month: m.month,
                valid: true,
                fee_date: m.feeDateStr,
                total: fees.length,
                can_delete: canDelete.length,
                blocked: blocked.length,
                fee_ids: feeIds,
            };
        });

        return {
            months: monthResults,
            total_can_delete: allDeletableIds.length,
            total_blocked: monthResults.reduce((s: number, m: any) => s + (m.blocked || 0), 0),
            all_deletable_fee_ids: allDeletableIds,
        };
    }

    // ─── Tabs 3 & 4: Confirm Delete ───────────────────────────────────────────

    async bulkDelete(dto: import('./dto/bulk-delete.dto').BulkDeleteDto, changedBy?: string) {
        const { student_fee_ids } = dto;

        // Re-validate — check if any voucher was added since preview
        const fees = await this.prisma.student_fees.findMany({
            where: { id: { in: student_fee_ids } },
            include: {
                voucher_heads: { select: { id: true }, take: 1 },
                fee_types: { select: { description: true } },
            },
        });

        const canDeleteRows = fees.filter((f: any) => f.voucher_heads.length === 0);
        const blockedRows = fees.filter((f: any) => f.voucher_heads.length > 0);
        const canDelete = canDeleteRows.map((f: any) => f.id);
        const blocked = blockedRows.map((f: any) => f.id);

        if (canDelete.length > 0) {
            await this.prisma.student_fees.deleteMany({
                where: { id: { in: canDelete } },
            });
            const distinctStudents = new Set(canDeleteRows.map((f: any) => f.student_id));
            const detailLimit = 20;
            const details = canDeleteRows.slice(0, detailLimit).map((f: any) =>
                `${f.fee_types?.description ?? 'fee'} (${this.periodLabel(f.target_month, f.academic_year, f.fee_date)}, ${this.fmtMoney(f.amount)})`,
            ).join(', ');
            this.auditLogs.log({
                entity_type: 'STUDENT_FEE_SCHEDULE',
                entity_id: canDelete.join(','),
                action: 'DELETED',
                section: 'finance',
                changed_by: changedBy ?? 'system',
                student_id: distinctStudents.size === 1 ? [...distinctStudents][0] as number : null,
                note: `Bulk deleted ${canDelete.length} fee row(s) across ${distinctStudents.size} student(s): ${details}` +
                    (canDeleteRows.length > detailLimit ? `, and ${canDeleteRows.length - detailLimit} more` : '') +
                    (blocked.length > 0 ? `. ${blocked.length} row(s) were blocked (already on a voucher).` : '.'),
            });
        }

        return { deleted: canDelete.length, blocked: blocked.length };
    }

    // ─── Fee-head Year Transfer ───────────────────────────────────────────────

    /**
     * Loads the heads for a transfer and works out, for each one, what its month
     * label reads today and what it would read at the destination.
     *
     * Shared by the preview and the transfer itself so the two can never drift:
     * whatever the admin approved in the preview is what gets written.
     */
    private async buildTransferRows(
        studentFeeIds: number[],
        targetAcademicYear: string,
        targetTermStartMonth: number,
    ) {
        const fees = await this.prisma.student_fees.findMany({
            where: { id: { in: studentFeeIds } },
            select: {
                id: true,
                student_id: true,
                fee_type_id: true,
                target_month: true,
                academic_year: true,
                term_start_month: true,
                amount: true,
                status: true,
                fee_types: { select: { description: true } },
                students: { select: { class_id: true, full_name: true, gr_number: true } },
                voucher_heads: {
                    select: {
                        vouchers: {
                            select: { id: true, class_id: true, status: true, paid_pdf_url: true },
                        },
                    },
                },
            },
            orderBy: [{ academic_year: 'asc' }, { target_month: 'asc' }],
        });

        const classTerms = await getClassTermMap(this.prisma);

        // Heads already sitting at the destination period — a transfer would put
        // two heads of the same fee type on the same month of the same year.
        const studentIds = [...new Set(fees.map((f) => f.student_id))];
        const existingAtTarget = studentIds.length
            ? await this.prisma.student_fees.findMany({
                where: {
                    student_id: { in: studentIds },
                    academic_year: targetAcademicYear,
                    id: { notIn: studentFeeIds },
                },
                select: { id: true, student_id: true, fee_type_id: true, target_month: true },
            })
            : [];
        const occupied = new Map<string, number>();
        for (const e of existingAtTarget) {
            occupied.set(`${e.student_id}|${e.fee_type_id ?? 'x'}|${e.target_month}`, e.id);
        }

        return fees.map((f) => {
            const vouchers = f.voucher_heads
                .map((vh) => vh.vouchers)
                .filter((v): v is NonNullable<typeof v> => v != null);
            const paidVoucher = vouchers.find((v) => v.status === 'PAID');
            const frozen = vouchers.find((v) => v.paid_pdf_url != null);

            // "Before" is the label as the fee schedule renders it — through the
            // student's *current* class. That is the screen the admin is looking
            // at when they decide to transfer, and the one showing the wrong
            // month for a student who has moved between term systems.
            const before = getMonthYearLabel(
                f.target_month,
                f.academic_year,
                termOfHead(f, { classId: f.students?.class_id ?? null, classTerms }),
            );
            // A voucher renders the same head through the class it was issued
            // against, so it can already disagree with the schedule. Surfaced
            // separately rather than folded into "before", which would hide the
            // change the admin is about to make.
            const onVoucher = vouchers.length
                ? getMonthYearLabel(
                    f.target_month,
                    f.academic_year,
                    termOfHead(f, { classId: vouchers[0].class_id, classTerms }),
                )
                : null;
            const after = getMonthYearLabel(f.target_month, targetAcademicYear, {
                termStartMonth: targetTermStartMonth,
                classId: null,
                classTerms: null,
            });

            const collisionWith = occupied.get(
                `${f.student_id}|${f.fee_type_id ?? 'x'}|${f.target_month}`,
            );

            return {
                id: f.id,
                student_id: f.student_id,
                student_name: f.students?.full_name ?? null,
                gr_number: f.students?.gr_number ?? null,
                fee_type: f.fee_types?.description ?? null,
                target_month: f.target_month,
                amount: f.amount,
                status: f.status,
                from_academic_year: f.academic_year,
                from_term_start_month: f.term_start_month,
                to_academic_year: targetAcademicYear,
                to_term_start_month: targetTermStartMonth,
                label_before: before,
                label_after: after,
                label_on_voucher: onVoucher,
                flags: {
                    on_voucher: vouchers.length > 0,
                    on_paid_voucher: paidVoucher != null,
                    frozen_receipt: frozen != null,
                    collision: collisionWith != null,
                    label_unchanged: before === after,
                    voucher_label_differs: onVoucher != null && onVoucher !== before,
                },
                voucher_ids: vouchers.map((v) => v.id),
                collision_with_fee_id: collisionWith ?? null,
            };
        });
    }

    /**
     * Read-only preview of a year transfer.
     *
     * Deliberately does NOT reuse the bulk-delete guard, which blocks any head
     * that sits on a voucher. Heads on vouchers are precisely the ones that need
     * moving here — a head stranded in the wrong academic year is one that was
     * billed before the student changed term systems. They surface as warnings
     * for the admin to weigh, never as blocks.
     */
    async transferPreview(params: {
        student_fee_ids: number[];
        target_academic_year: string;
        target_term_start_month: number;
    }) {
        const { student_fee_ids, target_academic_year, target_term_start_month } = params;
        if (!student_fee_ids.length) {
            throw new BadRequestException('student_fee_ids is required.');
        }
        if (![4, 8].includes(target_term_start_month)) {
            throw new BadRequestException('target_term_start_month must be 4 (Apr-Mar) or 8 (Aug-Jul).');
        }

        const rows = await this.buildTransferRows(
            student_fee_ids,
            target_academic_year,
            target_term_start_month,
        );

        return {
            rows,
            total: rows.length,
            changes: rows.filter((r) => !r.flags.label_unchanged).length,
            unchanged: rows.filter((r) => r.flags.label_unchanged).length,
            on_paid_voucher: rows.filter((r) => r.flags.on_paid_voucher).length,
            frozen_receipts: rows.filter((r) => r.flags.frozen_receipt).length,
            collisions: rows.filter((r) => r.flags.collision).length,
        };
    }

    /**
     * Move fee heads to another academic year.
     *
     * Writes academic_year and term_start_month together, always. Leaving the
     * term NULL would hand the head back to the class-derived fallback, which is
     * the exact ambiguity this column exists to remove.
     */
    async transferHeads(
        dto: import('./dto/transfer-heads.dto').TransferHeadsDto,
        changedBy?: string,
    ) {
        const { student_fee_ids, target_academic_year, target_term_start_month } = dto;

        if (!dto.acknowledgement) {
            throw new BadRequestException('acknowledgement is required to transfer fee heads.');
        }
        if (![4, 8].includes(target_term_start_month)) {
            throw new BadRequestException('target_term_start_month must be 4 (Apr-Mar) or 8 (Aug-Jul).');
        }

        // Re-read at execute time: the preview the admin approved may be stale.
        const rows = await this.buildTransferRows(
            student_fee_ids,
            target_academic_year,
            target_term_start_month,
        );
        if (rows.length === 0) {
            throw new NotFoundException('No fee heads found for the given ids.');
        }

        const ids = rows.map((r) => r.id);
        await this.prisma.$transaction([
            this.prisma.student_fees.updateMany({
                where: { id: { in: ids } },
                data: {
                    academic_year: target_academic_year,
                    term_start_month: target_term_start_month,
                },
            }),
        ]);

        // One entry per head, carrying both old values, so the move can be
        // reversed from the audit log alone.
        const distinctStudents = new Set(rows.map((r) => r.student_id));
        const changed = rows.filter((r) => !r.flags.label_unchanged);
        const summary: FeeAuditEvent = {
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: ids.join(','),
            action: 'TRANSFERRED',
            field: 'academic_year+term_start_month',
            old_value: [...new Set(rows.map((r) => r.from_academic_year))].join(', '),
            new_value: target_academic_year,
            note: `Transferred ${ids.length} fee head(s) across ${distinctStudents.size} student(s) ` +
                `to ${target_academic_year} (${target_term_start_month === 4 ? 'Apr-Mar' : 'Aug-Jul'} term); ` +
                `${changed.length} month label(s) changed. ` +
                `${rows.filter((r) => r.flags.on_paid_voucher).length} on a PAID voucher, ` +
                `${rows.filter((r) => r.flags.frozen_receipt).length} with a frozen receipt, ` +
                `${rows.filter((r) => r.flags.collision).length} colliding at the destination.`,
        };
        const events: FeeAuditEvent[] = rows.map((r) => ({
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: String(r.id),
            action: 'TRANSFERRED',
            field: 'academic_year+term_start_month',
            old_value: `${r.from_academic_year} / term ${r.from_term_start_month ?? 'NULL'}`,
            new_value: `${target_academic_year} / term ${target_term_start_month}`,
            note: `Transferred ${r.fee_type ?? 'fee'} (${this.fmtMoney(r.amount)}, ${r.status}) ` +
                `from ${r.from_academic_year} to ${target_academic_year}: ` +
                `label "${r.label_before}" -> "${r.label_after}"` +
                (r.flags.on_paid_voucher ? '; head is on a PAID voucher' : '') +
                (r.flags.frozen_receipt ? '; receipt PDF is frozen and keeps the old label' : '') +
                (r.flags.collision ? `; collides with fee #${r.collision_with_fee_id} at the destination` : ''),
        }));
        await this.flushAuditEvents(
            [summary, ...events],
            distinctStudents.size === 1 ? ([...distinctStudents][0] as number) : null,
            changedBy ?? 'system',
        );

        return {
            transferred: ids.length,
            student_fee_ids: ids,
            target_academic_year,
            target_term_start_month,
            rows,
        };
    }

    // ─── Discount Row Operations ──────────────────────────────────────────────

    /**
     * Create a discount row in student_fees.
     * Discount rows have is_discount=true, status=DISCOUNT, amount_paid=0.
     * fee_type_id is optional for discount rows.
     */
    async createDiscount(dto: {
        student_id: number;
        discount_type_id?: number | null;
        custom_title?: string;
        amount: number;
        fee_date?: string;
        target_month: number;
        academic_year: string;
    }, changedBy: string = 'system') {
        const student = await this.prisma.students.findUnique({ where: { cc: dto.student_id } });
        if (!student) throw new NotFoundException(`Student #${dto.student_id} not found`);

        if (!Number.isFinite(dto.amount) || dto.amount <= 0) {
            throw new BadRequestException(`Discount amount must be a positive number, got "${dto.amount}"`);
        }

        // Either an existing preset (must actually exist) or a custom_title (used to create one on the fly).
        let discountTypeId = dto.discount_type_id ?? null;
        if (discountTypeId != null) {
            const preset = await this.prisma.discount_presets.findUnique({ where: { id: discountTypeId } });
            if (!preset) throw new NotFoundException(`Discount preset #${discountTypeId} not found`);
        } else if (dto.custom_title?.trim()) {
            const newPreset = await this.prisma.discount_presets.create({
                data: { title: dto.custom_title.trim().toUpperCase(), is_active: true },
            });
            discountTypeId = newPreset.id;
        } else {
            throw new BadRequestException('Provide either a discount_type_id or a custom_title for the discount.');
        }

        // fee_date is optional — leave it null rather than passing an unparsable
        // value through to Prisma (new Date(undefined) is an "Invalid Date" and
        // crashes the insert with an opaque 500).
        let feeDate: Date | null = null;
        if (dto.fee_date) {
            const parsed = new Date(dto.fee_date);
            if (Number.isNaN(parsed.getTime())) {
                throw new BadRequestException(`Invalid fee_date "${dto.fee_date}" — expected format YYYY-MM-DD.`);
            }
            feeDate = parsed;
        }

        const { termByStudent: discountTerms } = await this.resolveTermsForStudents([dto.student_id]);

        const created = await this.prisma.student_fees.create({
            data: {
                student_id: dto.student_id,
                fee_type_id: null,
                discount_type_id: discountTypeId,
                is_discount: true,
                amount: new Prisma.Decimal(dto.amount),
                amount_paid: new Prisma.Decimal(0),
                academic_year: dto.academic_year,
                target_month: dto.target_month,
                term_start_month: discountTerms.get(dto.student_id) ?? DEFAULT_TERM_START_MONTH,
                fee_date: feeDate,
                status: 'DISCOUNT' as any,
            },
            include: {
                discount_presets: true,
            },
        });

        await this.auditLogs.log({
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: String(created.id),
            action: 'CREATED',
            section: 'finance',
            changed_by: changedBy,
            student_id: dto.student_id,
            note: `Discount of ${this.fmtMoney(dto.amount)} created for student #${dto.student_id} (${created.discount_presets?.title ?? dto.custom_title ?? 'custom'}), period ${this.periodLabel(dto.target_month, dto.academic_year, feeDate)}.`,
        });

        return created;
    }

    /**
     * "Universal" scholarship setter: writes one scholarship percentage onto
     * every existing MTF (fee_type_id=1, non-discount) row for a student in a
     * given academic year, since a student's scholarship is normally constant
     * for the whole year. One-time bulk write — does not affect MTF rows
     * added later in the year (those need the setter re-run, or the
     * percentage set per-row in bulkSaveStudentFees).
     */
    async applyScholarshipToStudent(dto: {
        student_id: number;
        academic_year: string;
        scholarship_percentage: number;
        scholarship_type_id?: number | null;
        custom_title?: string;
    }, changedBy: string = 'system') {
        const student = await this.prisma.students.findUnique({ where: { cc: dto.student_id } });
        if (!student) throw new NotFoundException(`Student #${dto.student_id} not found`);

        // Either an existing preset (must actually exist) or a custom_title (used to create one on the fly).
        let scholarshipTypeId = dto.scholarship_type_id ?? null;
        if (scholarshipTypeId != null) {
            const preset = await this.prisma.scholarship_presets.findUnique({ where: { id: scholarshipTypeId } });
            if (!preset) throw new NotFoundException(`Scholarship preset #${scholarshipTypeId} not found`);
        } else if (dto.custom_title?.trim()) {
            const newPreset = await this.prisma.scholarship_presets.create({
                data: { title: dto.custom_title.trim().toUpperCase(), is_active: true },
            });
            scholarshipTypeId = newPreset.id;
        } else {
            throw new BadRequestException('Provide either a scholarship_type_id or a custom_title for the scholarship.');
        }

        const rows = await this.prisma.student_fees.findMany({
            where: {
                student_id: dto.student_id,
                academic_year: dto.academic_year,
                fee_type_id: 1,
                is_discount: false,
            },
        });

        if (rows.length === 0) {
            return { updated: 0, rows: [] };
        }

        const pct = new Prisma.Decimal(dto.scholarship_percentage);
        const factor = new Prisma.Decimal(1).minus(pct.div(100));

        const updated = await this.prisma.$transaction(
            rows.map((row) => {
                // amount_after_discount is the stable base this scholarship is computed
                // from — it must be persisted (not just read), otherwise a second call
                // to this setter (e.g. changing the percentage) would fall back to the
                // already-discounted `amount` and double-apply the scholarship.
                const amountAfterDiscount = new Prisma.Decimal(
                    row.amount_after_discount ?? row.amount_before_discount ?? row.amount ?? 0,
                );
                // `amount` is the final receivable and is always a whole number.
                const finalAmount = amountAfterDiscount.mul(factor).toDecimalPlaces(0);
                return this.prisma.student_fees.update({
                    where: { id: row.id },
                    data: {
                        scholarship_percentage: pct,
                        scholarship_type_id: scholarshipTypeId,
                        amount_after_discount: amountAfterDiscount,
                        amount: finalAmount,
                    },
                });
            }),
        );

        await this.auditLogs.log({
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: String(dto.student_id),
            action: 'UPDATED',
            section: 'finance',
            changed_by: changedBy,
            student_id: dto.student_id,
            note: `Scholarship of ${dto.scholarship_percentage}% applied to ${updated.length} MTF row(s) for student #${dto.student_id}, academic year ${dto.academic_year}.`,
        });

        return { updated: updated.length, rows: updated };
    }

    /**
     * Fetch a student's REFUNDABLE/ADJUSTABLE CAUTION FEE row(s) (fee_type_id=3)
     * across all academic years — used to surface a caution fee taken years ago
     * (e.g. at O-3 admission) that won't show in the current year's schedule.
     */
    async getCautionFeeHistory(studentId: number) {
        return this.prisma.student_fees.findMany({
            where: { student_id: studentId, fee_type_id: 3, is_discount: false },
            select: { id: true, amount: true, amount_paid: true, fee_date: true, academic_year: true, status: true },
            orderBy: { academic_year: 'desc' },
        });
    }

    /**
     * Hard-reset a student's fee history:
     *   1. Delete all deposits  → cascades to deposit_allocations
     *   2. Delete all vouchers  → cascades to voucher_heads + voucher_arrear_surcharges
     *   3. Reset every student_fee back to NOT_ISSUED (status, dates, amount_paid)
     * Runs inside a single transaction so either everything rolls back or everything commits.
     */
    async resetAllHeads(studentId: number, changedBy: string = 'system') {
        const student = await this.prisma.students.findUnique({ where: { cc: studentId }, select: { cc: true, full_name: true } });
        if (!student) throw new NotFoundException(`Student #${studentId} not found`);

        // Capture full detail before the irreversible wipe — this is the only
        // record of exactly what existed once the transaction below commits.
        const [depositsBefore, vouchersBefore, feesBefore] = await Promise.all([
            this.prisma.deposits.findMany({
                where: { student_id: studentId },
                select: { id: true, total_amount: true },
            }),
            this.prisma.vouchers.findMany({
                where: { student_id: studentId },
                select: { id: true, voucher_number: true, status: true, total_payable_before_due: true },
            }),
            this.prisma.student_fees.findMany({
                where: { student_id: studentId, status: { not: 'NOT_ISSUED' } },
                select: { id: true, status: true, target_month: true, academic_year: true, fee_date: true },
            }),
        ]);

        const [deletedDeposits, deletedVouchers, resetFees] = await this.prisma.$transaction([
            this.prisma.deposits.deleteMany({ where: { student_id: studentId } }),
            this.prisma.vouchers.deleteMany({ where: { student_id: studentId } }),
            this.prisma.student_fees.updateMany({
                where: { student_id: studentId, status: { not: 'NOT_ISSUED' } },
                data: {
                    status: 'NOT_ISSUED',
                    issue_date: null,
                    due_date: null,
                    validity_date: null,
                    amount_paid: 0,
                },
            }),
        ]);

        await this.auditLogs.log({
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: String(studentId),
            action: 'DELETED',
            section: 'finance',
            changed_by: changedBy,
            student_id: studentId,
            note: [
                `FULL FEE HISTORY RESET for student #${studentId}${student.full_name ? ` (${student.full_name})` : ''} — irreversible, super-admin-only action.`,
                `Deleted ${deletedDeposits.count} deposit(s): ${depositsBefore.map((d) => this.fmtMoney(d.total_amount)).join(', ') || 'none'}.`,
                `Deleted ${deletedVouchers.count} voucher(s): ${vouchersBefore.map((v) => `#${v.id} (${v.voucher_number || 'N/A'}, ${v.status}, ${this.fmtMoney(v.total_payable_before_due)})`).join(', ') || 'none'}.`,
                `Reset ${resetFees.count} fee head(s) to Not Issued: ${feesBefore.map((f) => `${this.periodLabel(f.target_month, f.academic_year, f.fee_date)} (was ${f.status})`).join(', ') || 'none'}.`,
            ].join(' | '),
        });

        return {
            deletedDeposits: deletedDeposits.count,
            deletedVouchers: deletedVouchers.count,
            resetFees: resetFees.count,
        };
    }

    /**
     * Delete a discount row. Discount rows are safe to delete unless they appear
     * on a non-VOID voucher (same protection as regular fee rows).
     */
    async deleteDiscount(id: number, changedBy: string = 'system') {
        const fee = await this.prisma.student_fees.findUnique({
            where: { id },
            include: {
                voucher_heads: { select: { voucher_id: true } },
                discount_presets: { select: { title: true } },
            },
        });

        if (!fee) throw new NotFoundException(`Discount row #${id} not found`);
        if (!fee.is_discount) throw new BadRequestException(`Row #${id} is not a discount row`);

        if (fee.voucher_heads.length > 0) {
            throw new BadRequestException(
                `Discount row #${id} is included in a voucher — void the voucher first`,
            );
        }

        await this.prisma.student_fees.delete({ where: { id } });

        await this.auditLogs.log({
            entity_type: 'STUDENT_FEE_SCHEDULE',
            entity_id: String(id),
            action: 'DELETED',
            section: 'finance',
            changed_by: changedBy,
            student_id: fee.student_id,
            note: `Discount row #${id} deleted for student #${fee.student_id}: ${this.fmtMoney(fee.amount)} (${fee.discount_presets?.title ?? 'custom'}), period ${this.periodLabel(fee.target_month, fee.academic_year, fee.fee_date)}.`,
        });

        return { deleted: id };
    }
}
