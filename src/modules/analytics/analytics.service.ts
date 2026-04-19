import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  private getCurrentAcademicYear(): string {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); 
    const startYear = currentMonth >= 7 ? currentYear : currentYear - 1;
    return `${startYear}-${startYear + 1}`;
  }

  async getDashboardStats(campusId?: number) {
    const currentYear = this.getCurrentAcademicYear();

    const studentFilter: any = {
      status: 'ENROLLED',
      ...(campusId ? { campus_id: campusId } : {}),
      deleted_at: null,
    };

    const feeFilter: any = {
      students: studentFilter,
    };

    // 1. Current Year Financials
    const collectionStats = await this.prisma.student_fees.aggregate({
      where: {
        academic_year: currentYear,
        ...feeFilter,
      },
      _sum: {
        amount: true,
        amount_paid: true,
      },
    });

    const expected = Number(collectionStats._sum?.amount || 0);
    const collected = Number(collectionStats._sum?.amount_paid || 0);
    const outstanding = expected - collected;
    const collectionRate = expected > 0 ? (collected / expected) * 100 : 0;

    // 2. Arrears (Previous Years)
    const arrearsStats = await this.prisma.student_fees.aggregate({
      where: {
        academic_year: { not: currentYear },
        status: { not: 'PAID' },
        ...feeFilter,
      },
      _sum: {
        amount: true,
        amount_paid: true,
      },
    });

    const arrearsAmount = Number(arrearsStats._sum?.amount || 0) - Number(arrearsStats._sum?.amount_paid || 0);

    // 3. Student Strength
    const totalStudents = await this.prisma.students.count({
      where: studentFilter,
    });

    const branchCounts = await this.prisma.students.groupBy({
      by: ['campus_id'],
      where: { status: 'ENROLLED', deleted_at: null }, 
      _count: {
        cc: true,
      },
    });

    // Resolve campus names and list
    const campusesList = await this.prisma.campuses.findMany({
        select: { id: true, campus_name: true },
        orderBy: { campus_name: 'asc' }
    });
    const campusMap = new Map(campusesList.map((c) => [c.id, c.campus_name]));

    const branchwiseStrength = branchCounts.map((b) => ({
      campus_id: b.campus_id,
      campus_name: campusMap.get(b.campus_id || 0) || 'Unknown',
      count: b._count.cc,
    }));

    return {
      financials: {
        currentYear,
        expected,
        collected,
        outstanding,
        collectionRate,
        arrears: arrearsAmount,
      },
      students: {
        total: totalStudents,
        branchwise: branchwiseStrength,
      },
      campuses: campusesList
    };
  }
}
