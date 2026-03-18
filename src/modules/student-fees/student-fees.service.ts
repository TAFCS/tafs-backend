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

        // Check if student exists
        const student = await this.prisma.students.findUnique({
            where: { cc: student_id },
        });

        if (!student) {
            throw new NotFoundException(`Student with ID ${student_id} not found`);
        }

        try {
            return await this.prisma.$transaction(async (tx) => {
                // 1. Delete existing student-specific fees
                await tx.student_fees.deleteMany({
                    where: { student_id },
                });

                // 2. Create new fees with the gross price captured in amount_before_discount.
                //    The final billed price (post-discount) is snapshotted into
                //    voucher_heads.net_amount only when a voucher is issued.
                if (items.length > 0) {
                    // Deduplicate items to prevent unique constraint violations.
                    // If multiple items for the same fee_type/month/year exist, the last one wins.
                    const uniqueItemsMap = new Map<string, any>();
                    
                    items.forEach(item => {
                        const key = `${item.fee_type_id}-${item.month}-${item.target_month}-${item.academic_year}`;
                        uniqueItemsMap.set(key, {
                            student_id,
                            fee_type_id: item.fee_type_id,
                            month: item.month,
                            target_month: item.target_month,
                            academic_year: item.academic_year,
                            amount_before_discount: item.amount_before_discount,
                            status: 'NOT_ISSUED' as any,
                        });
                    });

                    const createData = Array.from(uniqueItemsMap.values());

                    await tx.student_fees.createMany({
                        data: createData,
                    });
                }

                return this.findByStudent(student_id);
            });
        } catch (error) {
            console.error('Bulk save failed:', error);
            throw error;
        }
    }
}
