import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BulkSaveStudentFeesDto } from './dto/bulk-save-student-fees.dto';

@Injectable()
export class StudentFeesService {
    constructor(private readonly prisma: PrismaService) { }

    async findByStudent(studentId: number) {
        return this.prisma.student_fees.findMany({
            where: { student_id: studentId },
            include: {
                fee_types: true,
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
}
