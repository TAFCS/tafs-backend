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
                        const bundleFees = allFees.filter((f) =>
                            b.fee_keys.includes(
                                `${f.fee_type_id}|${f.target_month}`,
                            ),
                        );

                        if (bundleFees.length > 0) {
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
                                    target_month: b.target_month,
                                },
                            });

                            await tx.student_fees.updateMany({
                                where: {
                                    id: { in: bundleFees.map((f) => f.id) },
                                },
                                data: {
                                    bundle_id: bundle.id,
                                    month: b.target_month,
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

    async createBundle(dto: CreateBundleDto) {
        const { student_id, bundle_name, total_amount, academic_year, fee_ids } = dto;

        // Verify fees belong to this student
        const fees = await this.prisma.student_fees.findMany({
            where: {
                id: { in: fee_ids },
                student_id,
            },
        });

        if (fees.length !== fee_ids.length) {
            throw new BadRequestException('One or more fees do not belong to the student');
        }

        return this.prisma.$transaction(async (tx) => {
            const feesForTotal = await tx.student_fees.findMany({
                where: { id: { in: fee_ids } },
                select: { amount: true, amount_before_discount: true }
            });

            const calculatedTotal = feesForTotal.reduce((sum, f) =>
                sum.add(new Prisma.Decimal(f.amount || f.amount_before_discount || 0)),
                new Prisma.Decimal(0)
            );

            const bundle = await tx.student_fee_bundles.create({
                data: {
                    student_id,
                    bundle_name,
                    total_amount: total_amount ? new Prisma.Decimal(total_amount) : calculatedTotal,
                    academic_year,
                    target_month: dto.target_month
                },
            });

            await tx.student_fees.updateMany({
                where: { id: { in: fee_ids } },
                data: {
                    bundle_id: bundle.id,
                    month: dto.target_month
                },
            });

            return bundle;
        });
    }

    async updateBundle(id: number, dto: Partial<CreateBundleDto>) {
        const { bundle_name, total_amount, academic_year, fee_ids, target_month } = dto;

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

                // 3. Link and sync new/current fees
                const finalFeeIds = fee_ids || (await tx.student_fees.findMany({ where: { bundle_id: id }, select: { id: true } })).map(f => f.id);
                const finalTargetMonth = target_month ?? bundle.target_month;

                await tx.student_fees.updateMany({
                    where: { id: { in: finalFeeIds } },
                    data: {
                        bundle_id: id,
                        month: finalTargetMonth
                    },
                });
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
}
