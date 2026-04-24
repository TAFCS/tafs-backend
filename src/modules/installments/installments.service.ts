import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateInstallmentDto } from './dto/create-installment.dto';

@Injectable()
export class InstallmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateInstallmentDto, userId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Create the installment group record for tracking
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

        // 2. Process each installment in the schedule
        for (let i = 0; i < dto.schedule.length; i++) {
          const item = dto.schedule[i];
          const mergeTarget = dto.merge_targets?.find(mt => mt.index === i);

          if (mergeTarget) {
            // Embedded: Add amount to existing head (e.g. Tuition Fee) and track the installment part
            await tx.student_fees.update({
              where: { id: mergeTarget.existing_head_id },
              data: {
                amount: { increment: item.amount },
                installment_amount: item.amount,
                installment_id: installmentGroup.id,
              },
            });
          } else {
            // Standalone: Create a new fee head for this installment
            await tx.student_fees.create({
              data: {
                student_id: dto.student_id,
                fee_type_id: dto.fee_type_id,
                academic_year: dto.academic_year,
                target_month: item.target_month,
                fee_date: new Date(item.fee_date),
                amount: item.amount,
                installment_amount: item.amount, // Record the installment portion
                installment_id: installmentGroup.id,
                status: 'NOT_ISSUED',
              },
            });
          }
        }

        return installmentGroup;
      }, {
        maxWait: 5000,
        timeout: 30000,
      });
    } catch (error) {
      console.error('Error creating installment:', error);
      throw new InternalServerErrorException('Failed to create installment schedule');
    }
  }
}
