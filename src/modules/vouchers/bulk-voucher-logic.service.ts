import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { deriveAcademicYear } from '../../common/utils/academic-labels';
import { getMonthlyFeeDates } from '../bulk-voucher-jobs/utils/bulk-date.utils';

@Injectable()
export class BulkVoucherLogicService {
    private readonly logger = new Logger(BulkVoucherLogicService.name);

    constructor(private readonly prisma: PrismaService) {}

    async fetchBaseData(params: {
        campus_id: number;
        class_id?: number;
        section_id?: number;
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
                campus_id: params.campus_id,
                ...(params.class_id ? { class_id: params.class_id } : {}),
                ...(params.section_id ? { section_id: params.section_id } : {}),
                ...(params.student_ccs ? { cc: { in: params.student_ccs } } : {}),
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
                },
                include: {
                    fee_types: { select: { description: true, priority_order: true } },
                },
            }),
            this.prisma.vouchers.findMany({
                where: {
                    student_id: { in: studentIds },
                    fee_date: { gte: feeDateFrom, lte: feeDateTo },
                    status: { not: 'VOID' },
                },
                select: { student_id: true, fee_date: true },
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
        
        // Set of "cc|dateStr" keys that already have a non-VOID voucher
        const existingVoucherKeys = new Set(
            existingVouchers
                .filter(v => v.fee_date)
                .map(v => `${v.student_id}|${v.fee_date!.toISOString().split('T')[0]}`),
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
                const alreadyIssued = existingVoucherKeys.has(voucherKey);

                if (alreadyIssued && skipAlreadyIssued) {
                    skips.push({
                        cc,
                        student_name: student.full_name,
                        status: 'SKIPPED',
                        reason: `Voucher already issued for period starting ${dateStr}`,
                        dateStr,
                    });
                } else {
                    const feesInThisMonth = dateMap.get(dateStr) || [];
                    if (feesInThisMonth.length === 0) {
                        skips.push({
                            cc,
                            student_name: student.full_name,
                            status: 'SKIPPED',
                            reason: `No unpaid fee heads found for period starting ${dateStr}`,
                            dateStr,
                        });
                    } else {
                        const itemAcademicYear = params.academic_year_override || deriveAcademicYear(dateStr, student.class_id ?? undefined);
                        workItems.push({ 
                            cc, 
                            dateStr, 
                            fees: feesInThisMonth, 
                            student, 
                            academicYear: itemAcademicYear,
                            alreadyIssued, // useful for preview
                        });
                    }
                }
            }
        }

        return { workItems, skips };
    }
}
