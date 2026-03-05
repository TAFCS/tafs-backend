import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SubmitStudentFeesDto } from './dto/submit-student-fees.dto';

@Injectable()
export class FeesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert student fee rows — one per (fee_type × month).
   * Uses PostgreSQL ON CONFLICT DO UPDATE so the operation is idempotent:
   * re-submitting the same student+fee_type+month updates the amount in place.
   */
  async submitStudentFees(dto: SubmitStudentFeesDto) {
    // Verify student exists
    const student = await this.prisma.students.findFirst({
      where: { id: dto.student_id, deleted_at: null },
      select: { id: true },
    });
    if (!student) {
      throw new NotFoundException(`Student with id ${dto.student_id} not found`);
    }

    // Bulk upsert inside a single transaction
    await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.$executeRaw`
          INSERT INTO student_fees (student_id, fee_type_id, amount, due_date, month, status)
          VALUES (
            ${dto.student_id}::int,
            ${item.fee_type_id}::int,
            ${new Prisma.Decimal(item.amount)},
            ${new Date(item.due_date)}::date,
            ${item.month}::int,
            false
          )
          ON CONFLICT (student_id, fee_type_id, month)
          DO UPDATE SET
            amount   = EXCLUDED.amount,
            due_date = EXCLUDED.due_date
        `,
      ),
    );

    return { upserted: dto.items.length };
  }
}
