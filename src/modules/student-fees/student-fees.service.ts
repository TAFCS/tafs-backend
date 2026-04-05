import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { BulkSaveStudentFeesDto } from './dto/bulk-save-student-fees.dto';
import { CreateBundleDto } from './dto/create-bundle.dto';

@Injectable()
export class StudentFeesService {
    constructor(private readonly prisma: PrismaService) { }

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
                student_fee_bundles: true,
                voucher_heads: {
                    orderBy: { id: 'desc' },
                    take: 1,
                    include: {
                        vouchers: {
                            select: { id: true, issue_date: true, status: true },
                        },
                    },
                },
            },
            orderBy: [
                { fee_date: 'asc' },
                { fee_types: { priority_order: 'asc' } },
            ],
        });

        // Group fees by fee_date
        const groupMap = new Map<string, typeof fees>();
        const ungrouped: typeof fees = [];

        for (const fee of fees) {
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
            fees, // Keep backward compat — flat list
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
        classId: number,
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
                student_fee_bundles: true,
            },
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
        const template = await this.prisma.class_fee_schedule.findMany({
            where: {
                class_id: classId,
                ...(campusId !== undefined
                    ? {
                        OR: [{ campus_id: campusId }, { campus_id: null }],
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


    async bulkSave(dto: BulkSaveStudentFeesDto) {
        const { student_id, items, bundles } = dto;

        if (items.length === 0) {
            return this.findByStudent(student_id);
        }

        const student = await this.prisma.students.findUnique({
            where: { cc: student_id },
        });
        if (!student) {
            throw new NotFoundException(`Student with ID ${student_id} not found`);
        }

        // Get the unique years involved in this save
        const years = Array.from(new Set(items.map((i) => i.academic_year)));

        return this.prisma.$transaction(
            async (tx) => {
                const existingFees = await tx.student_fees.findMany({
                    where: {
                        student_id,
                        academic_year: { in: years },
                    },
                    include: {
                        voucher_heads: { select: { id: true }, take: 1 },
                    },
                });

                const existingMap = new Map(
                    existingFees.map((f) => {
                        const dateStr = f.fee_date ? f.fee_date.toISOString().split('T')[0] : 'no-date';
                        const key = `${f.fee_type_id}|${f.target_month}|${f.academic_year}|${dateStr}`;
                        return [key, f];
                    }),
                );

                const incomingKeys = new Set(
                    items.map((i) => {
                        const tm = i.target_month ?? i.month ?? 8;
                        const dateStr = i.fee_date || 'no-date';
                        return `${i.fee_type_id}|${tm}|${i.academic_year}|${dateStr}`;
                    }),
                );

                // 1. Delete rows in the specified years that are NO LONGER in the incoming list AND have no vouchers.
                const toDelete = existingFees
                    .filter((f) => {
                        const dateStr = f.fee_date ? f.fee_date.toISOString().split('T')[0] : 'no-date';
                        const key = `${f.fee_type_id}|${f.target_month}|${f.academic_year}|${dateStr}`;
                        return !incomingKeys.has(key);
                    })
                    .filter((f) => f.voucher_heads.length === 0)
                    .map((f) => f.id);

                if (toDelete.length > 0) {
                    await tx.student_fees.deleteMany({
                        where: { id: { in: toDelete } },
                    });
                }

                // 2. Upsert items (Parallelized within transaction)
                const upsertPromises = items.map((item) => {
                    const tm = item.target_month ?? item.month ?? 8;
                    const targetMonth = tm > 0 ? tm : 8; // Ensure valid month
                    const dateStr = item.fee_date || 'no-date';
                    const key = `${item.fee_type_id}|${targetMonth}|${item.academic_year}|${dateStr}`;
                    const existing = existingMap.get(key);

                    if (existing) {
                        return tx.student_fees.update({
                            where: { id: existing.id },
                            data: {
                                month: item.month,
                                amount: item.amount,
                                amount_before_discount: item.amount_before_discount,
                                fee_date: item.fee_date ? new Date(item.fee_date) : null,
                            },
                        });
                    } else {
                        return tx.student_fees.create({
                            data: {
                                student_id,
                                fee_type_id: item.fee_type_id,
                                month: item.month,
                                academic_year: item.academic_year,
                                amount: item.amount,
                                amount_before_discount: item.amount_before_discount,
                                status: 'NOT_ISSUED' as any,
                                target_month: targetMonth,
                                fee_date: item.fee_date ? new Date(item.fee_date) : null,
                            },
                        });
                    }
                });
                await Promise.all(upsertPromises);

                // 3. Process Bundles if provided
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
                            // Use the provided target_month from the bundle DTO, or fall back 
                            // to the first member fee's period identity (target_month).
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
                        }
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
        );
    }

    /**
     * Explicitly update the fee_date for one or more student_fees records.
     * Called before bundle creation to persist any date changes the user made in the UI.
     */
    async updateFeeDates(updates: { id: number; fee_date: string }[]) {
        return this.prisma.$transaction(
            updates.map(({ id, fee_date }) =>
                this.prisma.student_fees.update({
                    where: { id },
                    data: { fee_date: new Date(fee_date) },
                }),
            ),
        );
    }    async createBundle(dto: CreateBundleDto) {
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

        return this.prisma.$transaction(async (tx) => {
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
    }

    async updateBundle(id: number, dto: Partial<CreateBundleDto>) {
        const { bundle_name, total_amount, academic_year, fee_ids, target_month, fee_date_overrides } = dto;

        const dateOverrideMap = new Map<number, Date>(
            (fee_date_overrides ?? []).map(({ id: fid, fee_date }) => [fid, new Date(fee_date)])
        );

        return this.prisma.$transaction(async (tx) => {
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
                    UPDATE student_fees 
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
    }

    async deleteBundle(id: number) {
        return this.prisma.$transaction(async (tx) => {
            // Revert member fees' month to their target_month (original period)
            await tx.$executeRaw`
                UPDATE student_fees 
                SET month = target_month 
                WHERE bundle_id = ${id}
            `;

            return tx.student_fee_bundles.delete({
                where: { id },
            });
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
                status: 'ENROLLED',
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

    private getCalendarYear(academicYear: string, month: number): number {
        const startYear = parseInt(academicYear.split('-')[0]);
        return month >= 8 ? startYear : startYear + 1;
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

    async bulkAdd(dto: import('./dto/bulk-add.dto').BulkAddDto) {
        const { academic_year, fee_type_id, month, fee_date, amount, student_ids } = dto;
        const targetDate = new Date(fee_date);

        let added = 0;
        let skipped = 0;
        const skipped_reasons: { student_id: number; reason: string }[] = [];

        await Promise.allSettled(
            student_ids.map(studentId =>
                this.prisma.$transaction(async (tx) => {
                    const existing = await tx.student_fees.findFirst({
                        where: { student_id: studentId, fee_type_id, fee_date: targetDate, academic_year },
                    });

                    if (existing) {
                        skipped++;
                        skipped_reasons.push({ student_id: studentId, reason: 'already_exists' });
                        return;
                    }

                    try {
                        await tx.student_fees.create({
                            data: {
                                student_id: studentId,
                                fee_type_id,
                                month,
                                target_month: month,
                                academic_year,
                                amount: new Prisma.Decimal(amount),
                                amount_before_discount: new Prisma.Decimal(amount),
                                fee_date: targetDate,
                                status: 'NOT_ISSUED' as any,
                            },
                        });
                        added++;
                    } catch (e: any) {
                        skipped++;
                        skipped_reasons.push({ student_id: studentId, reason: e?.code === 'P2002' ? 'already_exists' : 'error' });
                    }
                })
            )
        );

        return { added, skipped, skipped_reasons };
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
        const monthResults: any[] = [];

        const ACADEMIC_ORDER = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];
        const startIndex = ACADEMIC_ORDER.indexOf(start_month);
        const endIndex = ACADEMIC_ORDER.indexOf(end_month);

        for (let i = startIndex; i <= endIndex; i++) {
            const month = ACADEMIC_ORDER[i];
            const calYear = this.getCalendarYear(academic_year, month);
            if (!this.isValidDayForMonth(calYear, month, day)) {
                monthResults.push({ month, valid: false, reason: `Day ${day} doesn't exist in this month` });
                continue;
            }
            const feeDateStr = `${calYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const feeDate = new Date(feeDateStr);

            const existing = studentIds.length > 0
                ? await this.prisma.student_fees.findMany({
                    where: { student_id: { in: studentIds }, fee_type_id, fee_date: feeDate, academic_year },
                    select: { student_id: true },
                })
                : [];

            monthResults.push({
                month,
                valid: true,
                fee_date: feeDateStr,
                total_students: studentIds.length,
                existing: existing.length,
                will_add: studentIds.length - existing.length,
            });
        }

        return { months: monthResults, total_students: studentIds.length };
    }

    // ─── Tab 2: Confirm ───────────────────────────────────────────────────────

    async bulkAddRange(dto: import('./dto/bulk-add-range.dto').BulkAddRangeDto) {
        const { academic_year, fee_type_id, start_month, end_month, day, amount, student_ids } = dto;

        const monthSummary: any[] = [];
        let totalAddedNum = 0;
        let totalSkippedNum = 0;

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
                academic_year,
                amount: new Prisma.Decimal(amount),
                amount_before_discount: new Prisma.Decimal(amount),
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
        const monthResults: any[] = [];
        const allDeletableIds: number[] = [];

        const ACADEMIC_ORDER = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];
        const startIndex = ACADEMIC_ORDER.indexOf(start_month);
        const endIndex = ACADEMIC_ORDER.indexOf(end_month);

        for (let i = startIndex; i <= endIndex; i++) {
            const month = ACADEMIC_ORDER[i];
            const calYear = this.getCalendarYear(academic_year, month);
            if (!this.isValidDayForMonth(calYear, month, day)) {
                monthResults.push({ month, valid: false, reason: 'day_invalid', fee_date: null, total: 0, can_delete: 0, blocked: 0, fee_ids: [] });
                continue;
            }

            const feeDateStr = `${calYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const feeDate = new Date(feeDateStr);

            const fees = studentIds.length > 0
                ? await this.prisma.student_fees.findMany({
                    where: {
                        student_id: { in: studentIds },
                        academic_year,
                        fee_date: feeDate,
                        ...(fee_type_id ? { fee_type_id } : {}),
                    },
                    include: { voucher_heads: { select: { id: true }, take: 1 } },
                })
                : [];

            const canDelete = fees.filter((f: any) => f.voucher_heads.length === 0);
            const blocked = fees.filter((f: any) => f.voucher_heads.length > 0);
            const feeIds = canDelete.map((f: any) => f.id);
            allDeletableIds.push(...feeIds);

            monthResults.push({
                month,
                valid: true,
                fee_date: feeDateStr,
                total: fees.length,
                can_delete: canDelete.length,
                blocked: blocked.length,
                fee_ids: feeIds,
            });
        }

        return {
            months: monthResults,
            total_can_delete: allDeletableIds.length,
            total_blocked: monthResults.reduce((s: number, m: any) => s + (m.blocked || 0), 0),
            all_deletable_fee_ids: allDeletableIds,
        };
    }

    // ─── Tabs 3 & 4: Confirm Delete ───────────────────────────────────────────

    async bulkDelete(dto: import('./dto/bulk-delete.dto').BulkDeleteDto) {
        const { student_fee_ids } = dto;

        // Re-validate — check if any voucher was added since preview
        const fees = await this.prisma.student_fees.findMany({
            where: { id: { in: student_fee_ids } },
            include: { voucher_heads: { select: { id: true }, take: 1 } },
        });

        const canDelete = fees.filter((f: any) => f.voucher_heads.length === 0).map((f: any) => f.id);
        const blocked = fees.filter((f: any) => f.voucher_heads.length > 0).map((f: any) => f.id);

        if (canDelete.length > 0) {
            await this.prisma.student_fees.deleteMany({
                where: { id: { in: canDelete } },
            });
        }

        return { deleted: canDelete.length, blocked: blocked.length };
    }
}
