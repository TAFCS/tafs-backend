import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class AppPortalService {
  constructor(private prisma: PrismaService) {}

  async getStudentLedger(studentCc: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc: studentCc },
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        photograph_url: true,
        academic_year: true,
        campuses: { select: { campus_name: true } },
        classes: { select: { description: true } },
        sections: { select: { description: true } },
        houses: { select: { house_name: true } },
        dob: true,
        gender: true,
        student_guardians: {
          include: {
            guardians: {
              select: {
                full_name: true,
                primary_phone: true,
              },
            },
          },
        },
      },
    });

    if (!student) {
      throw new NotFoundException(`Student with CC ${studentCc} not found`);
    }

    // Fetch all relevant fees for this student
    const allFees = await this.prisma.student_fees.findMany({
      where: {
        student_id: studentCc,
      },
      include: {
        fee_types: true,
      },
      orderBy: [
        { academic_year: 'desc' },
        { target_month: 'desc' },
      ],
    });

    const outstandingHeads = allFees.filter(fee => {
      const isIssued = fee.status === 'ISSUED';
      const isPartial = fee.status === 'PARTIALLY_PAID';
      const notPaid = fee.status !== 'PAID';
      
      const amount = new Prisma.Decimal(fee.amount ?? 0);
      const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
      const payable = amount.sub(paid);

      return notPaid && (isIssued || isPartial) && payable.gt(0);
    });

    const paidHeads = allFees.filter(fee => fee.status === 'PAID');

    // Grouping helper
    const groupByMonth = (fees: any[]) => {
      const groups = new Map<string, any>();

      for (const fee of fees) {
        const key = `${fee.academic_year}-${fee.target_month}`;
        if (!groups.has(key)) {
          groups.set(key, {
            target_month: fee.target_month,
            academic_year: fee.academic_year,
            monthLabel: this.getMonthLabel(fee.target_month),
            heads: [],
            group_payable: 0,
          });
        }

        const group = groups.get(key);
        const amount = new Prisma.Decimal(fee.amount ?? 0);
        const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
        const payable = amount.sub(paid);

        group.heads.push({
          id: fee.id,
          description: `${fee.description_prefix ? fee.description_prefix + ' — ' : ''}${fee.fee_types.description}`,
          amount: amount.toNumber(),
          amount_paid: paid.toNumber(),
          payable: payable.toNumber(),
          status: fee.status,
          fee_date: fee.fee_date,
          is_issued: fee.status !== 'NOT_ISSUED',
        });

        group.group_payable += payable.toNumber();
      }

      return Array.from(groups.values());
    };

    const outstandingGroups = groupByMonth(outstandingHeads);
    const paidGroups = groupByMonth(paidHeads);

    const totalOutstanding = outstandingHeads.reduce((sum, fee) => {
      const amount = new Prisma.Decimal(fee.amount ?? 0);
      const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
      return sum.add(amount.sub(paid));
    }, new Prisma.Decimal(0));

    const totalPaidThisYear = paidHeads
      .filter(fee => fee.academic_year === student.academic_year)
      .reduce((sum, fee) => sum.add(new Prisma.Decimal(fee.amount_paid ?? 0)), new Prisma.Decimal(0));

    return {
      student: {
        cc: student.cc,
        full_name: student.full_name,
        gr_number: student.gr_number,
        campus: student.campuses?.campus_name,
        class: student.classes?.description,
        section: student.sections?.description,
        house: student.houses?.house_name,
        photograph_url: student.photograph_url,
        dob: student.dob,
        gender: student.gender,
        guardians: student.student_guardians.map(sg => ({
          name: sg.guardians.full_name,
          relationship: sg.relationship,
          phone: sg.guardians.primary_phone,
        })),
      },
      outstanding: outstandingGroups,
      paid: paidGroups,
      summary: {
        total_outstanding: totalOutstanding.toNumber(),
        total_paid_this_year: totalPaidThisYear.toNumber(),
      },
    };
  }

  private getMonthLabel(month: number): string {
    const labels = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return labels[month - 1] || 'Unknown';
  }
}
