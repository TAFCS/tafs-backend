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
                `${f.fee_type_id}|${f.target_month}|${f.academic_year}`,
                f,
            ]),
        );

        const incomingKeys = new Set(
            items.map((i) =>
                `${i.fee_type_id}|${i.target_month ?? i.month ?? 8}|${i.academic_year}`
            ),
        );

        // 1. Delete rows in the specified years that are NO LONGER in the incoming list AND have no vouchers.
        const toDelete = existingFees
            .filter((f) => !incomingKeys.has(`${f.fee_type_id}|${f.target_month}|${f.academic_year}`))
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
            const key = `${item.fee_type_id}|${targetMonth}|${item.academic_year}`;
            const existing = existingMap.get(key);

            if (existing) {
                writes.push(
                    this.prisma.student_fees.update({
                        where: { id: existing.id },
                        data: {
                            month: item.month,
                            amount: item.amount,
                            amount_before_discount: item.amount_before_discount,
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
            const bundle = await tx.student_fee_bundles.create({
                data: {
                    student_id,
                    bundle_name,
                    total_amount: total_amount ? new Prisma.Decimal(total_amount) : 0,
                    academic_year,
                },
            });

            await tx.student_fees.updateMany({
                where: { id: { in: fee_ids } },
                data: { bundle_id: bundle.id },
            });

            return bundle;
        });
    }

    async updateBundle(id: number, dto: Partial<CreateBundleDto>) {
        const { bundle_name, total_amount, academic_year, fee_ids } = dto;

        return this.prisma.$transaction(async (tx) => {
            const bundle = await tx.student_fee_bundles.update({
                where: { id },
                data: {
                    bundle_name,
                    total_amount: total_amount ? new Prisma.Decimal(total_amount) : undefined,
                    academic_year,
                },
            });

            if (fee_ids) {
                // Unlink old fees
                await tx.student_fees.updateMany({
                    where: { bundle_id: id },
                    data: { bundle_id: null },
                });

                // Link new fees
                await tx.student_fees.updateMany({
                    where: { id: { in: fee_ids } },
                    data: { bundle_id: id },
                });
            }

            return bundle;
        });
    }

    async deleteBundle(id: number) {
        return this.prisma.student_fee_bundles.delete({
            where: { id },
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
