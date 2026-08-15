import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { resolveVoucherAcademicYear } from '../../common/utils/academic-labels';
import { getMonthlyFeeDates } from '../bulk-voucher-jobs/utils/bulk-date.utils';

@Injectable()
export class BulkVoucherLogicService {
    private readonly logger = new Logger(BulkVoucherLogicService.name);

    constructor(private readonly prisma: PrismaService) {}

    async fetchBaseData(params: {
        campus_ids?: number[];
        class_ids?: number[];
        section_ids?: number[];
        fee_date_from: string;
        fee_date_to: string;
        student_ccs?: number[];
        include_statuses?: string[];
    }) {
        const feeDateFrom = new Date(params.fee_date_from);
        const feeDateTo = new Date(params.fee_date_to);
        const statuses = params.include_statuses || ['NOT_ISSUED'];

        // 1. Fetch Students
        const studentRecords = await this.prisma.students.findMany({
            where: {
                deleted_at: null,
                status: 'ENROLLED',
                ...(params.student_ccs?.length
                    ? { cc: { in: params.student_ccs } }
                    : {
                        ...(params.campus_ids?.length ? { campus_id: { in: params.campus_ids } } : {}),
                        ...(params.class_ids?.length ? { class_id: { in: params.class_ids } } : {}),
                        ...(params.section_ids?.length ? { section_id: { in: params.section_ids } } : {}),
                    }),
            },
            select: {
                cc: true,
                full_name: true,
                class_id: true,
                campus_id: true,
                section_id: true,
                gr_number: true,
                classes: { select: { description: true, class_code: true } },
                sections: { select: { description: true } },
            },
            orderBy: [{ classes: { description: 'asc' } }, { full_name: 'asc' }],
        });

        if (studentRecords.length === 0) return { studentRecords: [], matchingFees: [], existingVouchers: [] };

        const studentIds = studentRecords.map((s) => s.cc);

        // 2. Fetch Fees and Existing Vouchers
        const [matchingFees, existingVouchers] = await Promise.all([
            this.prisma.student_fees.findMany({
                where: {
                    student_id: { in: studentIds },
                    fee_date: { lte: feeDateTo },
                    status: { in: statuses as any },
                    is_discount: false, // discount rows are included separately per-voucher
                },
                include: {
                    fee_types: { select: { description: true, priority_order: true } },
                },
            }),
            this.prisma.vouchers.findMany({
                where: {
                    student_id: { in: studentIds },
                    fee_date: { gte: feeDateFrom, lte: feeDateTo },
                    status: { notIn: ['VOID', 'EXPIRED'] },
                },
                select: { student_id: true, fee_date: true, status: true },
            }),
        ]);

        return { studentRecords, matchingFees, existingVouchers };
    }

    resolveWorkItems(params: {
        studentRecords: any[];
        matchingFees: any[];
        existingVouchers: any[];
        fee_date_from: string;
        fee_date_to: string;
        expectedFeeDates: string[];
        skipAlreadyIssued: boolean;
        academic_year_override?: string;
    }) {
        const { studentRecords, matchingFees, existingVouchers, expectedFeeDates, skipAlreadyIssued } = params;
        const feeDateFrom = new Date(params.fee_date_from);
        
        // Map of "cc|dateStr" -> status, for every existing non-VOID, non-EXPIRED voucher
        const existingVoucherStatusByKey = new Map<string, string>(
            existingVouchers
                .filter(v => v.fee_date)
                .map(v => [`${v.student_id}|${v.fee_date!.toISOString().split('T')[0]}`, v.status]),
        );

        const workItems: any[] = [];
        const skips: any[] = [];

        for (const student of studentRecords) {
            const cc = student.cc;
            const studentFees = matchingFees.filter((f) => f.student_id === cc);

            // Map fees to their month (1st of month string)
            const dateMap = new Map<string, any[]>();
            const priorFees: any[] = [];

            for (const f of studentFees) {
                if (!f.fee_date) continue;
                const fDate = new Date(f.fee_date);
                if (fDate < feeDateFrom) {
                    priorFees.push(f);
                } else {
                    const monthKey = new Date(Date.UTC(fDate.getUTCFullYear(), fDate.getUTCMonth(), 1))
                        .toISOString()
                        .split('T')[0];
                    if (!dateMap.has(monthKey)) dateMap.set(monthKey, []);
                    dateMap.get(monthKey)!.push(f);
                }
            }

            const datesFound = Array.from(dateMap.keys()).sort();
            const firstDateInRange = expectedFeeDates[0];
            
            if (priorFees.length > 0 && !dateMap.has(firstDateInRange)) {
                dateMap.set(firstDateInRange, []);
                if (!datesFound.includes(firstDateInRange)) {
                    datesFound.push(firstDateInRange);
                    datesFound.sort();
                }
            }
            
            if (priorFees.length > 0) {
                const targetDate = datesFound[0];
                dateMap.set(targetDate, [...priorFees, ...(dateMap.get(targetDate) || [])]);
            }

            for (const dateStr of expectedFeeDates) {
                const voucherKey = `${cc}|${dateStr}`;
                const existingStatus = existingVoucherStatusByKey.get(voucherKey);
                const alreadyIssued = existingVoucherStatusByKey.has(voucherKey);
                const isPartiallyPaid = existingStatus === 'PARTIALLY_PAID';
                const feesInThisMonth = dateMap.get(dateStr) || [];

                if (feesInThisMonth.length > 0) {
                    // NOT_ISSUED heads exist — generate regardless of whether a prior voucher
                    // already exists for this period (handles the case where a previous voucher
                    // only captured some heads and new heads were added/reset afterward).
                    //
                    // If the existing voucher for this period is PARTIALLY_PAID, never touch/regenerate
                    // it — instead split off a brand-new voucher containing just the newly unpaid heads,
                    // and record a SKIPPED entry noting the partially-paid voucher was left untouched.
                    const itemAcademicYear = resolveVoucherAcademicYear(
                        feesInThisMonth
                            .filter((f: any) => !f.is_discount)
                            .map((f: any) => f.academic_year),
                        {
                            feeDate: dateStr,
                            term: { classId: student.class_id ?? null },
                            stored: params.academic_year_override,
                        },
                    );
                    workItems.push({
                        cc,
                        dateStr,
                        fees: feesInThisMonth,
                        student,
                        academicYear: itemAcademicYear,
                        alreadyIssued,
                        splitFromPartiallyPaid: isPartiallyPaid,
                    });
                    if (isPartiallyPaid) {
                        skips.push({
                            cc,
                            student_name: student.full_name,
                            status: 'SKIPPED',
                            reason: `Existing voucher for period starting ${dateStr} is partially paid — left untouched. A new voucher was split off for the remaining unpaid fee heads.`,
                            dateStr,
                            partially_paid: true,
                        });
                    }
                } else if (alreadyIssued && skipAlreadyIssued) {
                    skips.push({
                        cc,
                        student_name: student.full_name,
                        status: 'SKIPPED',
                        reason: isPartiallyPaid
                            ? `Voucher for period starting ${dateStr} is partially paid — regeneration skipped`
                            : `Voucher already issued for period starting ${dateStr}`,
                        dateStr,
                        partially_paid: isPartiallyPaid,
                    });
                } else {
                    skips.push({
                        cc,
                        student_name: student.full_name,
                        status: 'SKIPPED',
                        reason: `No unpaid fee heads found for period starting ${dateStr}`,
                        dateStr,
                    });
                }
            }
        }

        return { workItems, skips };
    }
}
