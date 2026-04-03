import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
      dto.items.map((item) => {
        const amount = new Prisma.Decimal(item.amount);
        return this.prisma.$executeRaw`
          INSERT INTO student_fees (student_id, fee_type_id, amount_before_discount, month, academic_year, status, target_month)
          VALUES (
            ${studentId}::int,
            ${item.fee_type_id}::int,
            ${amount},
            ${item.month}::int,
            ${item.academic_year},
            'NOT_ISSUED'::fee_status_enum,
            ${item.month}::int
          )
          ON CONFLICT (student_id, fee_type_id, month, academic_year)
          DO UPDATE SET
            amount_before_discount = EXCLUDED.amount_before_discount
        `;
      }),
    );

    return { upserted: dto.items.length };
  }

  async getFeeSummaryForParent(studentCc: number, familyId: number) {
    // 1. Ownership check
    const student = await this.prisma.students.findFirst({
      where: { cc: studentCc, family_id: familyId, deleted_at: null },
    });
    if (!student) {
      throw new ForbiddenException(
        `Student #${studentCc} not linked to your family`,
      );
    }

    const academicYear = student.academic_year;

    // 2. Total fees charged this academic year
    const totalCharged = await this.prisma.student_fees.aggregate({
      where: {
        student_id: studentCc,
        ...(academicYear ? { academic_year: academicYear } : {}),
      },
      _sum: { amount: true },
    });

    // 3. All vouchers for this student
    const vouchers = await this.prisma.vouchers.findMany({
      where: { student_id: studentCc },
      select: {
        id: true,
        status: true,
        total_payable_before_due: true,
        voucher_heads: {
          select: {
            amount_deposited: true,
            balance: true,
          },
        },
      },
    });

    const totalPaid = vouchers.reduce(
      (sum, v) =>
        sum +
        v.voucher_heads.reduce(
          (s, h) => s + Number(h.amount_deposited ?? 0),
          0,
        ),
      0,
    );

    const unpaidVouchers = vouchers.filter(
      (v) => v.status === 'UNPAID' || v.status === 'PARTIALLY_PAID',
    );
    const overdueAmount = unpaidVouchers.reduce(
      (sum, v) =>
        sum + v.voucher_heads.reduce((s, h) => s + Number(h.balance ?? 0), 0),
      0,
    );

    return {
      academicYear,
      totalCharged: Number(totalCharged._sum.amount ?? 0),
      totalPaid,
      outstandingBalance: overdueAmount,
      hasOverdue: overdueAmount > 0,
      overdueCount: unpaidVouchers.length,
    };
  }
}
