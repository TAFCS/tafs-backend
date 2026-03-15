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
            },
        });

        return {
            fees,
            family: student.families,
        };
    }

    async bulkSave(dto: BulkSaveStudentFeesDto) {
        const { student_id, items } = dto;

        // Check if student exists
        const student = await this.prisma.students.findUnique({
            where: { cc: student_id },
        });

        if (!student) {
            throw new NotFoundException(`Student with ID ${student_id} not found`);
        }

        return this.prisma.$transaction(async (tx) => {
            // 1. Delete existing student-specific fees
            await tx.student_fees.deleteMany({
                where: { student_id },
            });

            // 2. Create new fees with the gross price captured in amount_before_discount.
            //    The final billed price (post-discount) is snapshotted into
            //    voucher_heads.net_amount only when a voucher is issued.
            if (items.length > 0) {
                const createData = items.map((item) => ({
                    student_id,
                    fee_type_id: item.fee_type_id,
                    month: item.month,
                    academic_year: item.academic_year,
                    amount_before_discount: item.amount_before_discount,
                    status: 'NOT_ISSUED' as any,
                }));

                await tx.student_fees.createMany({
                    data: createData,
                });
            }

            return this.findByStudent(student_id);
        });
    }
}
