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
    // Resolve cc_number → internal student id
    const student = await this.prisma.students.findFirst({
      where: { cc: dto.cc, deleted_at: null },
      select: { cc: true },
    });
    if (!student) {
      throw new NotFoundException(`Student with CC ${dto.cc} not found`);
    }
    const studentId = student.cc;

    // Bulk upsert inside a single transaction
    await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.$executeRaw`
          INSERT INTO student_fees (student_id, fee_type_id, amount, month, academic_year, status)
          VALUES (
            ${studentId}::int,
            ${item.fee_type_id}::int,
            ${new Prisma.Decimal(item.amount)},
            ${item.month}::int,
            ${item.academic_year},
            false
          )
          ON CONFLICT (student_id, fee_type_id, month)
          DO UPDATE SET
            amount        = EXCLUDED.amount,
            academic_year = EXCLUDED.academic_year
        `,
      ),
    );

    return { upserted: dto.items.length };
  }
}
