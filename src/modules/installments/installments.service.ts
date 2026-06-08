import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateInstallmentDto } from './dto/create-installment.dto';
import { UpdateInstallmentDto } from './dto/update-installment.dto';

@Injectable()
export class InstallmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateInstallmentDto, userId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const installmentGroup = await tx.student_fee_installments.create({
          data: {
            student_id: dto.student_id,
            fee_type_id: dto.fee_type_id,
            academic_year: dto.academic_year,
            total_amount: dto.total_amount,
            installment_count: dto.installment_count,
            created_by: userId,
          },
        });

        for (let i = 0; i < dto.schedule.length; i++) {
          const item = dto.schedule[i];
          const mergeTarget = dto.merge_targets?.find(mt => mt.index === i);

          if (mergeTarget) {
            const targetFee = await tx.student_fees.findUnique({
              where: { id: mergeTarget.existing_head_id },
              select: { student_id: true, status: true, installment_id: true },
            });

            // Merging must only ever land on a fee head that (a) belongs to this
            // student, (b) hasn't been issued/paid yet — issuing snapshots
            // voucher_heads.net_amount from student_fees.amount, so incrementing
            // amount afterwards desyncs the voucher from the live balance — and
            // (c) isn't already part of another installment plan.
            if (!targetFee || targetFee.student_id !== dto.student_id) {
              throw new BadRequestException(
                `Merge target #${mergeTarget.existing_head_id} does not belong to this student.`,
              );
            }
            if (targetFee.status !== 'NOT_ISSUED') {
              throw new BadRequestException(
                `Merge target #${mergeTarget.existing_head_id} has already been issued and can no longer be merged into.`,
              );
            }
            if (targetFee.installment_id !== null) {
              throw new BadRequestException(
                `Merge target #${mergeTarget.existing_head_id} is already part of another installment plan.`,
              );
            }

            await tx.student_fees.update({
              where: { id: mergeTarget.existing_head_id },
              data: {
                amount: { increment: item.amount },
                installment_amount: item.amount,
                installment_id: installmentGroup.id,
              },
            });
          } else {
            await tx.student_fees.create({
              data: {
                student_id: dto.student_id,
                fee_type_id: dto.fee_type_id,
                academic_year: dto.academic_year,
                target_month: item.target_month,
                fee_date: new Date(item.fee_date),
                amount: item.amount,
                installment_amount: item.amount,
                installment_id: installmentGroup.id,
                status: 'NOT_ISSUED',
              },
            });
          }
        }

        return installmentGroup;
      }, { maxWait: 5000, timeout: 30000 });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      console.error('Error creating installment:', error);
      throw new InternalServerErrorException('Failed to create installment schedule');
    }
  }

  async findByStudent(studentId: number, academicYear?: string) {
    const plans = await this.prisma.student_fee_installments.findMany({
      where: {
        student_id: studentId,
        ...(academicYear ? { academic_year: academicYear } : {}),
      },
      include: {
        fee_types: { select: { id: true, description: true } },
        student_fees: {
          where: { is_discount: false },
          select: {
            id: true,
            fee_date: true,
            target_month: true,
            amount: true,
            installment_amount: true,
            status: true,
          },
          orderBy: { fee_date: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    });

    return plans.map(p => ({
      id: p.id,
      fee_type_id: p.fee_type_id,
      fee_type_desc: (p as any).fee_types?.description || '',
      academic_year: p.academic_year,
      total_amount: Number(p.total_amount),
      installment_count: p.installment_count,
      heads: (p as any).student_fees.map((sf: any) => ({
        id: sf.id,
        fee_date: sf.fee_date ? new Date(sf.fee_date).toISOString().split('T')[0] : null,
        target_month: sf.target_month || 0,
        amount: Number(sf.amount || 0),
        status: sf.status || 'NOT_ISSUED',
      })),
    }));
  }

  async update(id: number, dto: UpdateInstallmentDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        for (const head of dto.heads) {
          const fee = await tx.student_fees.findUnique({
            where: { id: head.student_fee_id },
            select: { status: true, installment_id: true },
          });
          // Only update NOT_ISSUED heads belonging to this plan
          if (!fee || fee.installment_id !== id || fee.status !== 'NOT_ISSUED') continue;

          await tx.student_fees.update({
            where: { id: head.student_fee_id },
            data: {
              ...(head.fee_date !== undefined ? { fee_date: new Date(head.fee_date) } : {}),
              ...(head.amount !== undefined ? { amount: head.amount, installment_amount: head.amount } : {}),
            },
          });
        }

        // Recalculate total from all current heads
        const allHeads = await tx.student_fees.findMany({
          where: { installment_id: id },
          select: { amount: true },
        });
        const newTotal = allHeads.reduce((sum, f) => sum + Number(f.amount || 0), 0);

        return tx.student_fee_installments.update({
          where: { id },
          data: { total_amount: newTotal },
        });
      }, { maxWait: 5000, timeout: 30000 });
    } catch (error) {
      console.error('Error updating installment:', error);
      throw new InternalServerErrorException('Failed to update installment plan');
    }
  }

  async removeHead(planId: number, headId: number) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const head = await tx.student_fees.findUnique({
          where: { id: headId },
          select: { status: true, installment_id: true },
        });

        if (!head || head.installment_id !== planId) {
          throw new BadRequestException('Head not found in this plan.');
        }
        if (head.status !== 'NOT_ISSUED') {
          throw new BadRequestException('Only pending (NOT_ISSUED) heads can be deleted.');
        }

        await tx.student_fees.delete({ where: { id: headId } });

        const remaining = await tx.student_fees.findMany({
          where: { installment_id: planId },
          select: { amount: true },
        });

        if (remaining.length === 0) {
          return tx.student_fee_installments.delete({ where: { id: planId } });
        }

        const newTotal = remaining.reduce((sum, f) => sum + Number(f.amount || 0), 0);
        return tx.student_fee_installments.update({
          where: { id: planId },
          data: { total_amount: newTotal, installment_count: remaining.length },
        });
      }, { maxWait: 5000, timeout: 30000 });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      console.error('Error deleting installment head:', error);
      throw new InternalServerErrorException('Failed to delete installment head');
    }
  }

  async remove(id: number) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const heads = await tx.student_fees.findMany({
          where: { installment_id: id },
          select: { id: true, status: true },
        });

        const paidHeads = heads.filter(h => h.status === 'PAID' || h.status === 'PARTIALLY_PAID');
        if (paidHeads.length > 0) {
          throw new BadRequestException(
            `Cannot delete: ${paidHeads.length} installment head(s) have already been paid.`,
          );
        }

        // Detach ISSUED heads (active voucher exists) rather than deleting them
        const issuedIds = heads.filter(h => h.status === 'ISSUED').map(h => h.id);
        if (issuedIds.length > 0) {
          await tx.student_fees.updateMany({
            where: { id: { in: issuedIds } },
            data: { installment_id: null, installment_amount: null },
          });
        }

        // Delete remaining NOT_ISSUED heads
        await tx.student_fees.deleteMany({
          where: { installment_id: id, status: 'NOT_ISSUED' },
        });

        return tx.student_fee_installments.delete({ where: { id } });
      }, { maxWait: 5000, timeout: 30000 });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      console.error('Error deleting installment:', error);
      throw new InternalServerErrorException('Failed to delete installment plan');
    }
  }
}
