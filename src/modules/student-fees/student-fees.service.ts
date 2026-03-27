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

    async findByStudentCC(ccNumber: string) {
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

        const fees = await this.prisma.student_fees.findMany({
            where: { student_id: student.cc },
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
            orderBy: {
                fee_types: {
                    priority_order: 'asc',
                },
            },
        });

        return {
            fees,
            family: student.families,
        };
    }

    async bulkSave(dto: BulkSaveStudentFeesDto) {
        const { student_id, items } = dto;

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
        const years = Array.from(new Set(items.map(i => i.academic_year)));

        const existingFees = await this.prisma.student_fees.findMany({
            where: { 
                student_id,
                academic_year: { in: years } 
            },
            include: {
                voucher_heads: { select: { id: true }, take: 1 },
            },
        });

        const existingMap = new Map(
            existingFees.map((f) => [
                `${f.fee_type_id}|${f.target_month}|${f.academic_year}|${f.fee_date ? new Date(f.fee_date).toISOString().split('T')[0] : ''}`,
                f,
            ]),
        );

        const incomingKeys = new Set(
            items.map((i) => {
                const tm = i.target_month ?? i.month ?? 8;
                const targetMonth = tm > 0 ? tm : 8;
                const dateKey = i.fee_date ?? '';
                return `${i.fee_type_id}|${targetMonth}|${i.academic_year}|${dateKey}`;
            }),
        );

        // 1. Delete rows in the specified years that are NO LONGER in the incoming list AND have no vouchers.
        const toDelete = existingFees
            .filter((f) => {
                const dateKey = f.fee_date ? new Date(f.fee_date).toISOString().split('T')[0] : '';
                return !incomingKeys.has(`${f.fee_type_id}|${f.target_month}|${f.academic_year}|${dateKey}`);
            })
            .filter((f) => f.voucher_heads.length === 0)
            .map((f) => f.id);

        const writes: any[] = [];
        if (toDelete.length > 0) {
            writes.push(this.prisma.student_fees.deleteMany({ where: { id: { in: toDelete } } }));
        }

        // 2. Upsert
        for (const item of items) {
            const tm = item.target_month ?? item.month ?? 8;
            const targetMonth = tm > 0 ? tm : 8; // Ensure valid month
            const dateKey = item.fee_date ?? '';
            const key = `${item.fee_type_id}|${targetMonth}|${item.academic_year}|${dateKey}`;
            const existing = existingMap.get(key);
            const feeDateValue = item.fee_date ? new Date(item.fee_date) : null;

            if (existing) {
                writes.push(
                    this.prisma.student_fees.update({
                        where: { id: existing.id },
                        data: {
                            month: item.month,
                            amount: item.amount,
                            amount_before_discount: item.amount_before_discount,
                            fee_date: feeDateValue,
                        },
                    })
                );
            } else {
                writes.push(
                    this.prisma.student_fees.create({
                        data: {
                            student_id,
                            fee_type_id: item.fee_type_id,
                            month: item.month,
                            academic_year: item.academic_year,
                            amount: item.amount,
                            amount_before_discount: item.amount_before_discount,
                            status: 'NOT_ISSUED' as any,
                            target_month: targetMonth,
                            fee_date: feeDateValue,
                        },
                    })
                );
            }
        }

        if (writes.length > 0) {
            await this.prisma.$transaction(writes);
        }

        return this.findByStudent(student_id);
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
            // Note: Postgres specific syntax for updates involving other table columns
            // Using raw query for clarity and multi-column sync if prisma doesn't support easily
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
